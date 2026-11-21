# Cairn ERP — End-User Guide

Welcome. This guide teaches you to **find your way around and do your daily work** in Cairn, a business system that covers buying and stock (MM), production (PP), selling (SD), finance and cost control (FICO) and people (HR). It is written for business users, not programmers.

## Table of Contents

- [What is Cairn?](#what-is-cairn)
- [Quick start (10 minutes)](#quick-start-10-minutes)
- [The guide at a glance](#the-guide-at-a-glance)
- [How to read the step-by-step pages](#how-to-read-the-step-by-step-pages)
- [Keeping this guide current](#keeping-this-guide-current)

> [!IMPORTANT]
> **Prerequisites**
> - A **tenant key** (four characters, for example `0100`), a **user name** and a **password**, given to you by your administrator.
> - A web browser. Nothing is installed on your computer.
> - At least one **role** assigned to your user. Without a role you can sign in but you will see an almost empty menu. See [Login and roles](01-getting-started/login-and-roles.md).

## What is Cairn?

Cairn is a single web application in which every department works on the same data. When the warehouse receives goods, stock goes up *and* the finance department's books are updated at the same moment — nobody types the same fact twice.

The work is organised into **modules**. These are the same names you see at the top level of the menu:

| Module (menu name) | What it is for | Typical users |
|---|---|---|
| **MM – Materials Management** | Materials, buying (requisitions, purchase orders), goods receipt and issue, stock, invoice checking | Buyers, warehouse staff |
| **PP – Production Planning** | Bills of materials, routings, planning what to make, production orders, confirming work done | Planners, production clerks |
| **QM – Quality Management** | Inspecting goods and recording the decision | Quality inspectors |
| **SD – Sales & Distribution** | Customers, sales orders, delivery, billing, prices | Sales clerks |
| **Finance & Controlling** (FICO) | The general ledger, customers and suppliers' accounts, assets, month-end close, cost centres and reports | Accountants, controllers |
| **HR – People** | Employees, positions, time and leave, payroll | HR clerks and officers |
| **Administration** | Users, roles, company structure, number ranges, audit tools | Administrators, auditors |

## Quick start (10 minutes)

1. **Sign in.** Open the address your administrator gave you. Enter **Tenant**, **User** and **Password**, then press **Sign in**. (Details and what the error messages mean: [Login and roles](01-getting-started/login-and-roles.md).)
2. **Look at the Launchpad.** This is your home page (`/`). It shows what is waiting for you, a **Start work** list tailored to your role, and the modules you may open.
3. **Open the menu.** On the left is the **Main menu**. Click a module, then a category, then an activity, then a screen. (More: [Navigation guide](01-getting-started/navigation-guide.md).)
4. **Jump straight to a screen.** Type a name or code into the **Command** box at the very top — for example `MM01` or `Create material` — and press **Enter**.
5. **Change your password.** Open the menu next to your name at the top right and choose **My account**.
6. **Read the three getting-started pages** below, then go to your own module.

## The guide at a glance

| Section | Pages |
|---|---|
| **1. Getting started** | [Login and roles](01-getting-started/login-and-roles.md) · [Navigation guide](01-getting-started/navigation-guide.md) · [Master data concepts](01-getting-started/master-data-concepts.md) |
| **2. MM – Materials Management** | [Overview](02-mm-materials-management/overview.md) · [Master data](02-mm-materials-management/master-data.md) · [Daily transactions](02-mm-materials-management/daily-transactions.md) · [Reports and troubleshooting](02-mm-materials-management/reports-and-troubleshooting.md) |
| **3. PP – Production Planning** | [Overview](03-pp-production-planning/overview.md) · [Master data](03-pp-production-planning/master-data.md) · [Daily transactions](03-pp-production-planning/daily-transactions.md) · [Reports and troubleshooting](03-pp-production-planning/reports-and-troubleshooting.md) |
| **4. SD – Sales & Distribution** | [Overview](04-sd-sales-distribution/overview.md) · [Master data](04-sd-sales-distribution/master-data.md) · [Daily transactions](04-sd-sales-distribution/daily-transactions.md) · [Reports and troubleshooting](04-sd-sales-distribution/reports-and-troubleshooting.md) |
| **5. FICO – Finance & Controlling** | [Overview](05-fico-finance-controlling/overview.md) · [Master data](05-fico-finance-controlling/master-data.md) · [Daily transactions](05-fico-finance-controlling/daily-transactions.md) · [Reports and troubleshooting](05-fico-finance-controlling/reports-and-troubleshooting.md) |
| **6. HR – Human Resources** | [Overview](06-hr-human-resources/overview.md) · [Master data](06-hr-human-resources/master-data.md) · [Daily transactions](06-hr-human-resources/daily-transactions.md) · [Reports and troubleshooting](06-hr-human-resources/reports-and-troubleshooting.md) |
| **7. End-to-end workflows** | [Procure to pay](07-end-to-end-workflows/procure-to-pay.md) · [Plan to produce](07-end-to-end-workflows/plan-to-produce.md) · [Order to cash](07-end-to-end-workflows/order-to-cash.md) · [Hire to retire](07-end-to-end-workflows/hire-to-retire.md) |

> [!NOTE]
> Pages for sections 2–7 are being written in phases. Until a page exists, its link above does not open yet.

## How to read the step-by-step pages

Every page in this guide follows the same layout so you always know where to look:

1. **Table of Contents** at the top.
2. **Prerequisites** box — what must already exist before you start (a material, a supplier, an open posting period…).
3. **Numbered steps** with realistic sample data. Follow them with the sample values the first time, then use your own.
4. **What happens in the background?** box — the automatic effects of your action: stock changes, accounting entries, status changes. Read it: it tells you *why* the step matters and what to check afterwards.
5. **Previous / Next** links at the bottom.

**Conventions used in the steps**

- Button and field names appear in **bold**, exactly as on screen.
- A field marked with an asterisk (`*`) on screen is **mandatory**. The guide says *mandatory* or *optional* for every field.
- Screen addresses are shown like `/inventory/materials`. You never type them: use the menu or the Command box.
- Sample data (for example material `RM-FLOUR-25`, supplier `Northern Mills`) is invented. Replace it with your own.

> [!TIP]
> **Read it in the app.** Signed-in users can open this whole guide at `/help` (the **User guide** link in the session bar). The app serves these same files, so an update here appears there at once.

## Keeping this guide current

This guide describes what the application does *today*. It is part of the product: whenever a screen, a field, a button label or a business rule changes, the page that describes it is changed in the same piece of work. The rule is recorded in the project's `CLAUDE.md`, and `npm run docs:check` verifies that every screen address named in these pages still exists and every link between pages opens.

---

**Next →** [Login and roles](01-getting-started/login-and-roles.md)
