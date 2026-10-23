# FastFood: eski (Admin) kompyuterdan kalitni olish. Faqat O'QIYDI: serverga, bazaga va
# parollarga tegmaydi. Eski kompyuterda, ma'lumotlar egasi bo'lgan Windows foydalanuvchisida
# bajariladi. Natija: <shu papka>\FastFood-Data\kochirish-kaliti.txt (maxfiy!).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $here 'FastFood-Data'
$out = Join-Path $data 'kochirish-kaliti.txt'
$state = if ($env:FASTFOOD_LOCAL_STATE) { $env:FASTFOOD_LOCAL_STATE } else { Join-Path $env:APPDATA 'FastFood\Local State' }

function Stop-With($text) {
  Write-Host ''
  Write-Host "XATO: $text" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path (Join-Path $data 'secrets.enc'))) {
  Stop-With "Shu papkada FastFood-Data (nusxa) topilmadi: $data`nSkriptni fleshkadagi FastFood-Data papkasi YONIGA qo'ying."
}
if (Test-Path (Join-Path $data 'pgdata\postmaster.pid')) {
  Stop-With "Nusxa server ishlab turganda olingan (pgdata\postmaster.pid bor).`nServerni tray (soat yonida) -> Chiqish bilan yoping, fleshkadagi FastFood-Data'ni o'chirib, %APPDATA%\FastFood-Data'ni qayta nusxalang."
}
if (-not (Test-Path $state)) {
  Stop-With "$state topilmadi. Bu kompyuterda FastFood server shu Windows foydalanuvchisida ishlamagan."
}
if (Test-Path $out) { Stop-With "$out allaqachon bor." }

Add-Type -AssemblyName System.Security
$json = Get-Content $state -Raw -Encoding UTF8 | ConvertFrom-Json
$blob = [Convert]::FromBase64String($json.os_crypt.encrypted_key)
if ([Text.Encoding]::ASCII.GetString($blob, 0, 5) -ne 'DPAPI') { Stop-With 'Kalit formati notanish.' }
$key = [Security.Cryptography.ProtectedData]::Unprotect(
  $blob[5..($blob.Length - 1)], $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser)
if ($key.Length -ne 32) { Stop-With 'Kalit uzunligi noto''g''ri.' }
[IO.File]::WriteAllText($out, [Convert]::ToBase64String($key))
Write-Host ''
Write-Host "TAYYOR: $out" -ForegroundColor Green
Write-Host "Endi FastFood-Data papkasini Kassa kompyuteriga o'tkazing (yo'riqnoma bo'yicha)."
Write-Host "Bu fayl MAXFIY: ko'chirish tugagach fleshkadan o'chiring."
