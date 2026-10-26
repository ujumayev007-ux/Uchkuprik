import { Socket } from 'node:net';
import os from 'node:os';
import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { EscPos } from '../../printing/escpos.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requireAnyPermission,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';

export function checkPrinterPing(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<{ online: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new Socket();
    let done = false;
    const finish = (online: boolean, error?: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      const result: { online: boolean; latencyMs: number; error?: string } = {
        online,
        latencyMs: Date.now() - start,
      };
      if (error !== undefined) {
        result.error = error;
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false, 'Timeout'));
    socket.once('error', (err) => finish(false, err.message));
    socket.connect(port, host, () => finish(true));
  });
}

/**
 * The API opens TCP connections to printer addresses, so addresses are limited to
 * private LAN IPv4 ranges and raw printing ports. This prevents using printer
 * settings to reach loopback, link-local (cloud metadata) or public hosts.
 */
export function isAllowedPrinterHost(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

const printerInput = z.object({
  branchId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['RECEIPT', 'KITCHEN']),
  stationId: z.uuid().nullable().optional(),
  host: z.string().trim().refine(isAllowedPrinterHost),
  port: z.number().int().min(9100).max(9109).default(9100),
  isActive: z.boolean().default(true),
  // Kitchen tickets that keep failing are copied once to this printer.
  fallbackPrinterId: z.uuid().nullable().optional(),
  // 58 and 80 mm are the common widths; other widths are custom (40-112 mm).
  paperWidth: z.number().int().min(40).max(112).default(80),
  allowDuplicate: z.boolean().default(false).optional(),
});

export function printersRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [
    requireAuth(),
    requireAnyPermission('settings.manage', 'pos.access'),
  ];
  const terminalAccess = [
    requireAuth(),
    // Oshxona and Ofitsiant see the printers, check them and print a test page.
    requireAnyPermission(
      'settings.manage',
      'pos.access',
      'kitchen.access',
      'orders.create',
    ),
  ];

  router.get('/printers', ...terminalAccess, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const printers = await db.printer.findMany({
      where: { tenantId: auth.tenantId, branchId: branch.id },
      orderBy: { name: 'asc' },
    });
    res.json({
      printers: printers.map(
        ({
          id,
          name,
          kind,
          stationId,
          host,
          port,
          isActive,
          fallbackPrinterId,
          paperWidth,
        }) => ({
          paperWidth,
          id,
          name,
          kind,
          stationId,
          fallbackPrinterId,
          host,
          port,
          isActive,
        }),
      ),
    });
  });

  const write = async (
    tenantId: string,
    input: z.infer<typeof printerInput>,
  ) => {
    if (input.stationId) {
      const station = await db.kitchenStation.findFirst({
        where: { id: input.stationId, tenantId },
      });
      if (!station) throw errors.validation([{ path: 'stationId' }]);
    }
    if (input.fallbackPrinterId) {
      const fallback = await db.printer.findFirst({
        where: { id: input.fallbackPrinterId, tenantId },
      });
      if (!fallback) throw errors.validation([{ path: 'fallbackPrinterId' }]);
    }
    return {
      fallbackPrinterId: input.fallbackPrinterId ?? null,
      paperWidth: input.paperWidth,
      branchId: input.branchId,
      name: input.name,
      kind: input.kind,
      stationId: input.kind === 'KITCHEN' ? (input.stationId ?? null) : null,
      host: input.host,
      port: input.port,
      isActive: input.isActive,
    };
  };

  router.post('/printers', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(printerInput, req.body);
    await resolveBranch(db, auth, input.branchId);

    const duplicate = await db.printer.findFirst({
      where: {
        tenantId: auth.tenantId,
        branchId: input.branchId,
        host: input.host,
        port: input.port,
        isActive: true,
      },
    });
    if (duplicate && !input.allowDuplicate) {
      throw new AppError(
        409,
        'DUPLICATE_PRINTER_IP',
        'conflict',
        `Ushbu IP manzil (${input.host}:${input.port}) allaqachon "${duplicate.name}" printerida ishlatilmoqda`,
      );
    }

    const data = await write(auth.tenantId, input);
    const printer = await db.printer.create({
      data: { tenantId: auth.tenantId, ...data },
    });
    await audit(db, req, {
      tenantId: auth.tenantId,
      branchId: input.branchId,
      actorUserId: auth.userId,
      action: 'printer.create',
      entityType: 'printer',
      entityId: printer.id,
      data: { host: input.host, port: input.port, kind: input.kind },
    });
    res.status(201).json({ id: printer.id });
  });

  router.patch('/printers/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(printerInput, req.body);
    const existing = await db.printer.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!existing) throw errors.notFound();
    await resolveBranch(db, auth, existing.branchId);
    await resolveBranch(db, auth, input.branchId);

    const duplicate = await db.printer.findFirst({
      where: {
        tenantId: auth.tenantId,
        branchId: input.branchId,
        host: input.host,
        port: input.port,
        isActive: true,
        id: { not: id },
      },
    });
    if (duplicate && !input.allowDuplicate) {
      throw new AppError(
        409,
        'DUPLICATE_PRINTER_IP',
        'conflict',
        `Ushbu IP manzil (${input.host}:${input.port}) allaqachon "${duplicate.name}" printerida ishlatilmoqda`,
      );
    }

    await db.printer.update({
      where: { id },
      data: await write(auth.tenantId, input),
    });
    await audit(db, req, {
      tenantId: auth.tenantId,
      branchId: input.branchId,
      actorUserId: auth.userId,
      action: 'printer.update',
      entityType: 'printer',
      entityId: id,
      data: { host: input.host, port: input.port },
    });
    res.json({ ok: true });
  });

  // Removes a printer added by mistake or no longer used. Its print queue goes with it;
  // printers that used it as their fallback simply lose that fallback.
  router.delete('/printers/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const existing = await db.printer.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!existing) throw errors.notFound();
    await resolveBranch(db, auth, existing.branchId);
    await db.$transaction(async (tx) => {
      await tx.printer.updateMany({
        where: { tenantId: auth.tenantId, fallbackPrinterId: id },
        data: { fallbackPrinterId: null },
      });
      await tx.printer.delete({ where: { id } });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: existing.branchId,
        actorUserId: auth.userId,
        action: 'printer.delete',
        entityType: 'printer',
        entityId: id,
        data: { name: existing.name, host: existing.host, port: existing.port },
      });
    });
    res.status(204).end();
  });

  router.post('/printers/:id/ping', ...terminalAccess, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const printer = await db.printer.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!printer) throw errors.notFound();
    const status = await checkPrinterPing(printer.host, printer.port);
    res.json({ ...status, printerId: printer.id, host: printer.host, port: printer.port });
  });

  router.post('/printers/ping-host', ...terminalAccess, async (req, res) => {
    const input = parse(
      z.object({
        host: z.string().trim().refine(isAllowedPrinterHost),
        port: z.number().int().min(9100).max(9109).default(9100),
      }),
      req.body,
    );
    const status = await checkPrinterPing(input.host, input.port);
    res.json(status);
  });

  // The networks of the restaurant computer (where printers must be reachable from):
  // the printer form completes a bare "50" to "<subnet>.50" and scans these by default.
  router.get('/printers/subnets', ...terminalAccess, (_req, res) => {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter(
        (item): item is os.NetworkInterfaceInfo =>
          !!item &&
          item.family === 'IPv4' &&
          !item.internal &&
          isAllowedPrinterHost(item.address),
      )
      .map((item) => item.address);
    const subnets = [
      ...new Set(addresses.map((address) => address.split('.').slice(0, 3).join('.'))),
    ];
    res.json({ subnets, addresses });
  });

  router.post('/printers/discover-lan', ...terminalAccess, async (req, res) => {
    const input = parse(
      z.object({
        subnet: z
          .string()
          .trim()
          .regex(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
          .optional(),
      }),
      req.body,
    );
    const prefix = input.subnet || '192.168.1';
    const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    const batchSize = 32;
    const discovered: Array<{ host: string; port: number; latencyMs: number }> = [];
    for (let i = 0; i < hosts.length; i += batchSize) {
      const batch = hosts.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (host) => {
          const ping = await checkPrinterPing(host, 9100, 350);
          return ping.online ? { host, port: 9100, latencyMs: ping.latencyMs } : null;
        }),
      );
      for (const r of results) {
        if (r) discovered.push(r);
      }
    }
    res.json({ discovered });
  });

  router.post('/printers/seed-departments', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const standards = [
      { name: 'Kassa', sortOrder: 1 },
      { name: 'Asosiy oshxona', sortOrder: 2 },
      { name: 'Baliqxona', sortOrder: 3 },
      { name: 'Kabobxona', sortOrder: 4 },
      { name: 'Fastfud', sortOrder: 5 },
      { name: 'Ichimliklar', sortOrder: 6 },
    ];
    for (const item of standards) {
      const exists = await db.kitchenStation.findFirst({
        where: { tenantId: auth.tenantId, name: item.name },
      });
      if (!exists) {
        await db.kitchenStation.create({
          data: {
            tenantId: auth.tenantId,
            name: item.name,
            sortOrder: item.sortOrder,
            isActive: true,
          },
        });
      }
    }
    const stations = await db.kitchenStation.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { sortOrder: 'asc' },
    });
    res.json({ stations });
  });

  router.post('/printers/:id/test', ...terminalAccess, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const printer = await db.printer.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { station: true },
    });
    if (!printer) throw errors.notFound();
    await resolveBranch(db, auth, printer.branchId);

    const esc = new EscPos(printer.paperWidth === 58 ? 32 : 48)
      .align('center')
      .bold(true)
      .line('FAST FOOD — SINOV CHEKI')
      .bold(false)
      .line(`Printer: ${printer.name}`)
      .line(
        `Bo‘lim: ${printer.station?.name ?? (printer.kind === 'RECEIPT' ? 'Kassa' : 'Umumiy oshxona')}`,
      )
      .line(`IP: ${printer.host}:${printer.port}`)
      .line(`Kenglik: ${printer.paperWidth} mm`)
      .line(new Date().toISOString().slice(0, 16).replace('T', ' '));
    if (printer.kind === 'RECEIPT') {
      esc.cashDrawer(2); // kick pulse to test cash drawer
    }
    const payload = esc.feed(4).cut().build();

    const job = await db.printJob.create({
      data: {
        tenantId: auth.tenantId,
        printerId: id,
        kind: printer.kind,
        payload,
      },
    });
    res.status(201).json({ jobId: job.id });
  });

  // Recovery view: recent jobs and their delivery state (payloads are not exposed).
  router.get('/print-jobs', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const jobs = await db.printJob.findMany({
      where: { tenantId: auth.tenantId, printer: { branchId: branch.id } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { printer: { select: { name: true } } },
    });
    res.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        printer: job.printer.name,
        kind: job.kind,
        purpose: job.purpose,
        fallback: !!job.fallbackFromId,
        orderId: job.orderId,
        status: job.status,
        attempts: job.attempts,
        lastError: job.lastError,
        createdAt: job.createdAt,
        sentAt: job.sentAt,
      })),
    });
  });

  router.post('/print-jobs/:id/retry', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const result = await db.printJob.updateMany({
      where: {
        id,
        tenantId: auth.tenantId,
        status: { in: ['FAILED', 'PENDING'] },
      },
      data: {
        status: 'PENDING',
        attempts: 0,
        nextTryAt: new Date(),
        lastError: null,
      },
    });
    if (result.count === 0) throw errors.notFound();
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'print.retry',
      entityType: 'print_job',
      entityId: id,
    });
    res.json({ ok: true });
  });

  return router;
}
