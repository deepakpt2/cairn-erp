-- B-119: add the approved Plant logistics/address fields without reformatting legacy values.
-- factory_calendar is an optional, unvalidated key until a separate calendar master exists;
-- it must not be used by operational paths before that master and validation are implemented.
ALTER TABLE "plant" ADD COLUMN "region" varchar(80);
ALTER TABLE "plant" ADD COLUMN "postal_code" varchar(20);
ALTER TABLE "plant" ADD COLUMN "street" varchar(160);
ALTER TABLE "plant" ADD COLUMN "house_number" varchar(40);
ALTER TABLE "plant" ADD COLUMN "factory_calendar" varchar(10);
