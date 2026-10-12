-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money and quantity invariants enforced in the database as well as the API.
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_amounts" CHECK ("price" >= 0 AND ("cost" IS NULL OR "cost" >= 0));
ALTER TABLE "branch_variant_prices" ADD CONSTRAINT "branch_variant_prices_amount" CHECK ("price" IS NULL OR "price" >= 0);
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_amounts" CHECK ("price" >= 0 AND ("cost" IS NULL OR "cost" >= 0));
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_selection" CHECK ("minSelect" >= 0 AND "maxSelect" >= 1 AND "minSelect" <= "maxSelect");
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_seats" CHECK ("seats" BETWEEN 1 AND 100);
ALTER TABLE "tenant_profiles" ADD CONSTRAINT "tenant_profiles_service_charge" CHECK ("serviceChargeBp" BETWEEN 0 AND 3000);
ALTER TABLE "products" ADD CONSTRAINT "products_prep_time" CHECK ("prepTimeMinutes" IS NULL OR "prepTimeMinutes" BETWEEN 0 AND 600);
