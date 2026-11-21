# Navigation Guide

How to find any screen quickly, how a typical screen is laid out, and what the little notices on screen mean.

## Table of Contents

- [The parts of the window](#the-parts-of-the-window)
- [The Launchpad](#the-launchpad)
- [The Main menu](#the-main-menu)
- [The Command box](#the-command-box)
- [Searching](#searching)
- [Favourites and Recent](#favourites-and-recent)
- [Related screens](#related-screens)
- [Notifications](#notifications)
- [Reading a typical screen](#reading-a-typical-screen)
- [Locks: "is being changed by…"](#locks-is-being-changed-by)
- [Common messages and what to do](#common-messages-and-what-to-do)
- [Using Cairn on a phone or tablet](#using-cairn-on-a-phone-or-tablet)

> [!IMPORTANT]
> **Prerequisites**
> - You are signed in (see [Login and roles](login-and-roles.md)).
> - You hold a role. The menu and the Command box only offer screens you may open, so a new user with no role sees very little.

## The parts of the window

| Part | Where | What it does |
|---|---|---|
| **Command box** | Top bar, wide text box with an **Execute** button | Type a screen's name or code and press **Enter** to open it. |
| **Quick links** | Top bar, right of the Command box | **Tenants**, **Configuration workbench** and **Term registry** — shown only if your role allows them. |
| **User guide** | Session bar, left of the bell | Opens this guide inside the app at `/help`. Every page is also reachable from its index; links between pages work as in the files. |
| **Session bar** | Under the top bar | Your **Tenant** key, your user name, how many authorities you hold, and a menu with **My account** and **Sign out**. |
| **Main menu** | Left side | The module → category → activity → screen tree, with a search box, **Favourites** and **Recent**. |
| **Work area** | Centre | The screen itself. |
| **Status bar** | Bottom | Whether the system is **Ready** or **Working…**, your tenant and user, the **Environment**, and the **Menu path** of the screen you are on. |

## The Launchpad

The Launchpad (`/`) is your home page. Click **Cairn** at the top left from anywhere to return to it.

- **What waits on you** — appears only when something needs you, for example a document that is blocked or an account action. Each line links to the item. When nothing is waiting, the section is not shown at all.
- **Start work** — the screens that create or post, grouped by module, limited to the work your role allows.
- **Modules** — a list of the modules you may open.
- Administrators also see tiles for **Tenant administration**, the **Configuration workbench** and **Number range intervals**.

## The Main menu

The menu has four levels, always in this order:

**Module → Category → Activity → Screen**

*Example:* **MM – Materials Management** → **Procurement** → **Purchase orders** → **Create purchase order**.

Step by step:

1. Click a **module** name to open it (or press **Show…** beside it to expand it in place). Clicking a module title also opens a page (`/menu?module=mm`) that lists all of that module's screens by category.
2. Click a **category** to expand it.
3. Click the **screen** name.

Things to know:

- Within a module, categories are alphabetical, with **Configuration** always last: the setup that a few people do comes after the work everyone does.
- A screen can appear under more than one activity. It is still the same screen.
- **The menu only shows screens you may open.** Showing a screen in the menu grants nothing; the screen checks your authority again when it opens.
- The **Dashboard** entry takes you to the Launchpad.

The modules in the menu are: **Dashboard**, **MM – Materials Management**, **PP – Production Planning**, **QM – Quality Management**, **Finance & Controlling**, **SD – Sales & Distribution**, **HR – People** and **Administration**.

## The Command box

The Command box is the fastest way to move. It is like a "go to" box.

1. Click in the box at the top (it is focused when a page opens), or just start typing.
2. Type one of these and press **Enter** (or click **Execute**):
   - a **transaction code** you already know, for example `MM01`, `MIGO`, `ME21N`, `FB50`;
   - a **screen code**, for example `INV.MATERIAL.CREATE` (codes look like `FIN.JOURNAL.POST`);
   - a **name or part of one**, for example `purchase order`.
3. If one screen is clearly the best match, it opens immediately. If several match about equally well, you are shown a **list** to choose from. If nothing matches you see *Nothing matches "…"* with hints.

Sample codes (each opens the screen named in the second column):

| Type this | Opens |
|---|---|
| `MM01` | **Create material** (`/inventory/materials`) |
| `ME21N` | **Create purchase order** (`/purchasing/orders`) |
| `MIGO` | **Goods movement** (`/inventory/migo`) |
| `FB50` | **Post a journal entry** (`/finance/journal/new`) |
| `CO01` | **Create production order** (`/production/orders`) |
| `MD04` | **Stock/requirements list** (`/production/stock-requirements`) |
| `XD01` or `XK01` | **Create business partner** (`/foundation/partners`) |
| `PA30` | **Employees** (`/people/employees`) |
| `FS00` | **G/L account master create** (`/config/gl-accounts/new`) |

> [!NOTE]
> **What happens in the background?**
> The Command box only *opens* a screen. It never posts, confirms or changes anything. The system looks the term up in its **term registry**, which also knows the familiar codes from other ERP systems as *aliases* — that is why `MM01` works even though this system names its own screens differently. The screen you land on still checks that you are allowed to use it.

## Searching

Two searches exist and they do different jobs:

| Search | Where | Use it to |
|---|---|---|
| **Search the menu** | Search box at the top of the **Main menu**, and the page `/search` | Find a screen you can open by a word in its name, activity or function. The page says *No screen you can open matches "…"* if nothing fits. |
| **Term registry** | Quick link **Term registry**, page `/registry` | Look up any code, table name or concept, including ones you cannot open yourself — see what it is called, its aliases ("Also known as") and whether it is built. |

## Favourites and Recent

- **Recent** lists the last **8** screens you opened, newest first, automatically.
- **Favourites** are screens you choose to keep. Open a screen, then use **Add this screen to favourites** in the menu; use **Remove this screen from favourites** to undo. You can keep up to **20**; the list refuses more.
- They are personal. Other users do not see yours.

## Related screens

Many screens show a strip titled **Related screens** under the page header — the screens that belong beside the one you are on. **More related screens** expands the list and **All screens** opens the complete list of built screens.

Opening a related screen never posts, confirms or runs anything. Where the next screen reads a selection field that you already filled in (a material or plant number, for instance), that value is carried across so you do not retype it.

## Notifications

The **bell** shows how many notifications you have not yet seen (*"3 unseen"*). Messages arrive when a document you own is released, refused or blocked, or when something is waiting for you to act on. Open the list (`/platform/notifications`) and use **Mark seen** or **Mark all seen**.

## Reading a typical screen

Every screen is built from the same kit, so once you know one you know them all:

1. **Header** — the screen name, with its code beside it, and sometimes a short description.
2. **Related screens** strip.
3. **Panels** — a bordered block with a title. A *selection* panel (what do you want to see?) sits above a *result* panel.
4. **Fields** — a label above each box. **A star (\*) means mandatory.** Where the screen says *Optional*, you may leave it empty. Dropdowns list only valid values.
5. **Buttons** — the main action (**Save**, **Post**, **Create account**…) is the highlighted button; secondary ones are plain; buttons that remove or revoke something (for example **Revoke**) are marked in red.
6. **Messages** — after you press a button, a green message confirms, or a red message explains the refusal in plain words **and says what to do next**. Read the second sentence; it is the remedy.

## Locks: "is being changed by…"

Two people must not change the same record at the same moment. When you open an object another user is editing, the screen shows:

> *Purchase order 4500000012 is being changed by mfarah. This opening is display only.* (the object name and number differ by screen)

You may read it but not change it. Wait until the other person leaves the screen, or ask them to finish. Administrators can see all locks on **Lock monitor** (`/platform/locks`).

Some master records (for example plants and storage locations) also carry a **version**. If someone saved the record after you opened it, your save is refused rather than silently overwriting their work: reload the screen, look at what changed, and repeat your change.

## Common messages and what to do

| What you see | What it means | What to do |
|---|---|---|
| *This screen requires authority X. Ask an administrator to update your role.* | You may not open this screen. | Send the message to your administrator. |
| *Read-only view. Changes require authority X.* | You can display but not change. | Ask for the authority if you need to change. |
| *… does not stand* / *does not exist* | The object is missing **or** is outside your company or plant access. | Check the number; if it is right, ask your administrator about your access. |
| *Nothing matches "…"* (Command box) | No screen has that name or code. | Try a shorter word, or use **Search the menu**. |
| *… is being changed by …* | A lock. | Wait or ask the other user. |

## Using Cairn on a phone or tablet

On a narrow screen the Main menu becomes a **drawer**. Press **Menu** at the top to slide it open; **Close** (or the Escape key) closes it, and choosing a screen closes it for you. The Command box moves onto its own line.

---

**← Previous** [Login and roles](login-and-roles.md) · **Next →** [Master data concepts](master-data-concepts.md)
