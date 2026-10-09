CREATE TABLE "material" (
	"client" varchar(4) NOT NULL,
	"material_number" varchar(40) NOT NULL,
	"description" varchar(200) DEFAULT '' NOT NULL,
	"material_type" varchar(12) NOT NULL,
	"material_group" varchar(20),
	"base_unit" varchar(6),
	"industry_sector" varchar(20),
	"barcode" varchar(32),
	"gross_weight" numeric(23, 3) DEFAULT '0' NOT NULL,
	"net_weight" numeric(23, 3) DEFAULT '0' NOT NULL,
	"weight_unit" varchar(6),
	"basic_status" varchar(16) DEFAULT 'INCOMPLETE' NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"low_level_code" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "material_client_material_number_pk" PRIMARY KEY("client","material_number"),
	CONSTRAINT "material_basic_status_ck" CHECK ("material"."basic_status" in ('INCOMPLETE','CREATED','MAINTAINED')),
	CONSTRAINT "material_weight_ck" CHECK ("material"."gross_weight" >= 0 and "material"."net_weight" >= 0 and "material"."gross_weight" >= "material"."net_weight")
);
--> statement-breakpoint
CREATE TABLE "material_group" (
	"client" varchar(4) NOT NULL,
	"material_group" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "material_group_client_material_group_pk" PRIMARY KEY("client","material_group")
);
--> statement-breakpoint
CREATE TABLE "material_plant" (
	"client" varchar(4) NOT NULL,
	"material_number" varchar(40) NOT NULL,
	"plant" varchar(10) NOT NULL,
	"purchasing_group" varchar(6),
	"order_unit" varchar(6),
	"overdelivery_tolerance" numeric(5, 2) DEFAULT '0' NOT NULL,
	"underdelivery_tolerance" numeric(5, 2) DEFAULT '0' NOT NULL,
	"manufacturer_part_number" varchar(80),
	"purchasing_status" varchar(16) DEFAULT 'NOT_CREATED' NOT NULL,
	"mrp_type" varchar(16),
	"mrp_controller" varchar(3),
	"procurement_type" varchar(8),
	"lot_sizing" varchar(16),
	"fixed_lot_size" numeric(23, 3) DEFAULT '0' NOT NULL,
	"minimum_lot_size" numeric(23, 3) DEFAULT '0' NOT NULL,
	"maximum_lot_size" numeric(23, 3) DEFAULT '0' NOT NULL,
	"safety_stock" numeric(23, 3) DEFAULT '0' NOT NULL,
	"reorder_point" numeric(23, 3) DEFAULT '0' NOT NULL,
	"planned_delivery_days" integer DEFAULT 0 NOT NULL,
	"in_house_production_days" integer DEFAULT 0 NOT NULL,
	"mrp_status" varchar(16) DEFAULT 'NOT_CREATED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "material_plant_client_material_number_plant_pk" PRIMARY KEY("client","material_number","plant"),
	CONSTRAINT "material_plant_codes_ck" CHECK (("material_plant"."mrp_type" is null or "material_plant"."mrp_type" in ('REQUIREMENTS','REORDER','NONE')) and ("material_plant"."procurement_type" is null or "material_plant"."procurement_type" in ('BUY','MAKE','BOTH')) and ("material_plant"."lot_sizing" is null or "material_plant"."lot_sizing" in ('EXACT','FIXED'))),
	CONSTRAINT "material_plant_quantities_ck" CHECK ("material_plant"."fixed_lot_size" >= 0 and "material_plant"."minimum_lot_size" >= 0 and "material_plant"."maximum_lot_size" >= 0 and "material_plant"."safety_stock" >= 0 and "material_plant"."reorder_point" >= 0 and "material_plant"."planned_delivery_days" >= 0 and "material_plant"."in_house_production_days" >= 0),
	CONSTRAINT "material_plant_tolerance_ck" CHECK ("material_plant"."overdelivery_tolerance" between 0 and 100 and "material_plant"."underdelivery_tolerance" between 0 and 100),
	CONSTRAINT "material_plant_status_ck" CHECK ("material_plant"."purchasing_status" in ('NOT_CREATED','INCOMPLETE','CREATED','MAINTAINED') and "material_plant"."mrp_status" in ('NOT_CREATED','INCOMPLETE','CREATED','MAINTAINED'))
);
--> statement-breakpoint
CREATE TABLE "material_type" (
	"client" varchar(4) NOT NULL,
	"material_type" varchar(12) NOT NULL,
	"name" varchar(100) NOT NULL,
	"default_procurement_type" varchar(8) NOT NULL,
	"default_price_control" varchar(16) NOT NULL,
	"is_stocked" boolean DEFAULT true NOT NULL,
	"is_valuated" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "material_type_client_material_type_pk" PRIMARY KEY("client","material_type")
);
--> statement-breakpoint
CREATE TABLE "material_valuation" (
	"client" varchar(4) NOT NULL,
	"material_number" varchar(40) NOT NULL,
	"valuation_area" varchar(10) NOT NULL,
	"valuation_class" varchar(20),
	"price_control" varchar(16) NOT NULL,
	"standard_price" numeric(23, 4) DEFAULT '0' NOT NULL,
	"moving_average_price" numeric(23, 4) DEFAULT '0' NOT NULL,
	"price_unit" numeric(23, 3) DEFAULT '1' NOT NULL,
	"currency" char(3) NOT NULL,
	"total_stock_quantity" numeric(23, 3) DEFAULT '0' NOT NULL,
	"stock_value" numeric(23, 4) DEFAULT '0' NOT NULL,
	"accounting_status" varchar(16) DEFAULT 'INCOMPLETE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "material_valuation_client_material_number_valuation_area_pk" PRIMARY KEY("client","material_number","valuation_area"),
	CONSTRAINT "material_valuation_codes_ck" CHECK ("material_valuation"."price_control" in ('STANDARD','MOVING_AVERAGE') and "material_valuation"."accounting_status" in ('INCOMPLETE','CREATED','MAINTAINED')),
	CONSTRAINT "material_valuation_values_ck" CHECK ("material_valuation"."standard_price" >= 0 and "material_valuation"."moving_average_price" >= 0 and "material_valuation"."price_unit" > 0 and "material_valuation"."total_stock_quantity" >= 0 and "material_valuation"."stock_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mrp_controller" (
	"client" varchar(4) NOT NULL,
	"controller" varchar(3) NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "mrp_controller_client_controller_pk" PRIMARY KEY("client","controller")
);
--> statement-breakpoint
CREATE TABLE "planning_file" (
	"client" varchar(4) NOT NULL,
	"material_number" varchar(40) NOT NULL,
	"plant" varchar(10) NOT NULL,
	"net_change" boolean DEFAULT true NOT NULL,
	"reason" varchar(80) NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_by" varchar(60) NOT NULL,
	CONSTRAINT "planning_file_client_material_number_plant_pk" PRIMARY KEY("client","material_number","plant")
);
--> statement-breakpoint
CREATE TABLE "valuation_class" (
	"client" varchar(4) NOT NULL,
	"valuation_class" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"allowed_material_types" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "valuation_class_client_valuation_class_pk" PRIMARY KEY("client","valuation_class")
);
--> statement-breakpoint
ALTER TABLE "material" ADD CONSTRAINT "material_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material" ADD CONSTRAINT "material_base_unit_unit_of_measure_code_fk" FOREIGN KEY ("base_unit") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material" ADD CONSTRAINT "material_weight_unit_unit_of_measure_code_fk" FOREIGN KEY ("weight_unit") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material" ADD CONSTRAINT "material_client_material_type_material_type_client_material_type_fk" FOREIGN KEY ("client","material_type") REFERENCES "public"."material_type"("client","material_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material" ADD CONSTRAINT "material_client_material_group_material_group_client_material_group_fk" FOREIGN KEY ("client","material_group") REFERENCES "public"."material_group"("client","material_group") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_group" ADD CONSTRAINT "material_group_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_plant" ADD CONSTRAINT "material_plant_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_plant" ADD CONSTRAINT "material_plant_order_unit_unit_of_measure_code_fk" FOREIGN KEY ("order_unit") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_plant" ADD CONSTRAINT "material_plant_client_material_number_material_client_material_number_fk" FOREIGN KEY ("client","material_number") REFERENCES "public"."material"("client","material_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_plant" ADD CONSTRAINT "material_plant_client_plant_plant_client_plant_fk" FOREIGN KEY ("client","plant") REFERENCES "public"."plant"("client","plant") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_plant" ADD CONSTRAINT "material_plant_client_purchasing_group_purchasing_group_client_purchasing_group_fk" FOREIGN KEY ("client","purchasing_group") REFERENCES "public"."purchasing_group"("client","purchasing_group") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_plant" ADD CONSTRAINT "material_plant_client_mrp_controller_mrp_controller_client_controller_fk" FOREIGN KEY ("client","mrp_controller") REFERENCES "public"."mrp_controller"("client","controller") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_type" ADD CONSTRAINT "material_type_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_valuation" ADD CONSTRAINT "material_valuation_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_valuation" ADD CONSTRAINT "material_valuation_client_material_number_material_client_material_number_fk" FOREIGN KEY ("client","material_number") REFERENCES "public"."material"("client","material_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_valuation" ADD CONSTRAINT "material_valuation_client_valuation_area_plant_client_plant_fk" FOREIGN KEY ("client","valuation_area") REFERENCES "public"."plant"("client","plant") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_valuation" ADD CONSTRAINT "material_valuation_client_valuation_class_valuation_class_client_valuation_class_fk" FOREIGN KEY ("client","valuation_class") REFERENCES "public"."valuation_class"("client","valuation_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mrp_controller" ADD CONSTRAINT "mrp_controller_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_file" ADD CONSTRAINT "planning_file_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_file" ADD CONSTRAINT "planning_file_client_material_number_plant_material_plant_client_material_number_plant_fk" FOREIGN KEY ("client","material_number","plant") REFERENCES "public"."material_plant"("client","material_number","plant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuation_class" ADD CONSTRAINT "valuation_class_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "material_description_idx" ON "material" USING btree ("client","description");