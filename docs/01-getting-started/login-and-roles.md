# Login and Roles

This page explains how to sign in, how to look after your account, and how **roles** decide what you can see and do.

## Table of Contents

- [Why sign-in has three fields](#why-sign-in-has-three-fields)
- [Signing in](#signing-in)
- [If sign-in fails](#if-sign-in-fails)
- [Forgot your password](#forgot-your-password)
- [My account](#my-account)
- [Two-factor authentication](#two-factor-authentication)
- [Roles, authorities and scope](#roles-authorities-and-scope)
- [The standard roles](#the-standard-roles)
- [For administrators: users, roles and business access](#for-administrators-users-roles-and-business-access)
- [Signing out](#signing-out)

> [!IMPORTANT]
> **Prerequisites**
> - Your administrator has created your account and told you the **tenant key**, **user name** and starting **password**.
> - Your user has at least one **role** (without one the menu is nearly empty).
> - For anything that touches a company's data, your administrator has also given you **business access** to that company (see [Roles, authorities and scope](#roles-authorities-and-scope)).

## Why sign-in has three fields

A **tenant** is one complete, separate set of company data inside the system (the same word is sometimes written *client*). Two tenants never see each other's data. So the system needs to know *which* tenant you work in before it can check your user name — that is why the first field is **Tenant**.

## Signing in

1. Open the address of the system. You land on the sign-in page.
2. Fill in the three fields:

| Field | Mandatory? | What to enter | Sample |
|---|---|---|---|
| **Tenant** | Mandatory | The four-character tenant key. Capital letters are applied for you. | `0100` |
| **User** | Mandatory | Your user name. Capitals or small letters both work. | `jsmith` |
| **Password** | Mandatory | Your password. | — |

3. Press **Sign in**.
4. Depending on how your tenant is set up, one of three things happens next:
   - You land on the **Launchpad** — you are in.
   - You are taken to the **Change password** page of *My account* — an administrator reset your password, so you must choose a new one before anything else.
   - You are asked for a **six-digit code** — your tenant uses two-factor authentication (see [below](#two-factor-authentication)).

> [!NOTE]
> **What happens in the background?**
> - The system checks the tenant, user and password together. Every attempt — successful or not — is written to an access log that auditors can review.
> - A successful sign-in creates a **session**. A session stays valid for **twelve hours** and is extended while you keep working, so you are not signed out in the middle of a task. An abandoned browser is signed out on its own.
> - A wrong password adds one to a failed-attempt counter on your user. A successful sign-in clears it.

## If sign-in fails

The red message tells you what to do:

| Message | What it means | What to do |
|---|---|---|
| *The tenant, user or password is not correct.* | One of the three fields is wrong. The system deliberately does not say which. | Check all three fields, including the tenant key. |
| *This user is not active.* | Your account was switched off. | Ask an administrator to activate it. |
| *This user is locked after too many failed attempts.* | Five failed attempts in a row lock the user. | An administrator must unlock you (see [administrators](#for-administrators-users-roles-and-business-access)). Waiting does not help. |
| *That second-factor step has ended.* | The six-digit code step timed out or you used up its attempts. This does **not** lock you. | Sign in again from the start. |
| *Sign-in could not be completed.* | Something else went wrong. | Try again; if it keeps failing, check the tenant key and tell your administrator. |

## Forgot your password

1. On the sign-in page choose **Request a reset** (under the form).
2. On the **Forgot password** page fill in:

| Field | Mandatory? | Sample |
|---|---|---|
| **Tenant** | Mandatory | `0100` |
| **User** | Mandatory | `jsmith` |

3. Submit. The page always gives the same answer whether or not the account exists, so nobody can use it to find out who has an account. If your account has an email address, a **reset link** is mailed to you; it is valid for 60 minutes.
4. Open the link. On the **Reset password** page enter a **new password** twice (both mandatory, at least 10 characters).
5. Sign in with the new password.

If no email arrives, ask your administrator to send you a reset link from the user's details page.

> [!NOTE]
> **What happens in the background?**
> The link carries a one-time token that is valid for **60 minutes** and works **once**; it is stored only as a hash and is never shown to anyone on screen — it is only mailed. Requesting a reset (by you or by an administrator) signs out every session the user currently has open.

## My account

Open it from the menu next to your name at the top right of any page: **My account** (page `/account`). It has four sections:

| Section | What you can do |
|---|---|
| **Password** | **Change password** — fields **Current password**, **New password**, **Confirmation** (all mandatory). |
| **Two-factor** | Turn two-factor authentication on or off and manage recovery codes. |
| **Sessions** | See where you are signed in. **Sign out of this session** ends the current one; **Close** ends another one (for example one you left open on a shared computer). |
| **Preferences** | **Logon language** — choose it and press **Save**. |

### Password rules

A password must have **at least 10 characters**, at least **one letter** and at least **one digit**. Example of an acceptable password: `Harvest2026!`. Choose something nobody can guess and do not reuse it elsewhere.

### Changing your password — step by step

1. Open **My account** → **Password**.
2. Type your **Current password**.
3. Type the **New password** and repeat it in **Confirmation**.
4. Press **Change password**.

> [!NOTE]
> **What happens in the background?**
> The session you are using stays open; **every other session of yours is closed**, so a password you changed because someone else may have seen it takes effect everywhere. If an administrator had reset your password, the "must change password" flag is cleared once you finish, and the rest of the menu opens up.

## Two-factor authentication

Two-factor authentication (2FA) means that, besides your password, you type a six-digit code that changes every 30 seconds and is shown by an authenticator app on your phone.

**Turning it on**

1. **My account** → **Two-factor** → **Set up**.
2. Scan the **QR code** with an authenticator app (or type the printed key by hand).
3. Type the six-digit number the app shows into **Code from the app** and press **Confirm**. Nothing is protected until you confirm.
4. Recovery codes are shown **once**. Copy them, store them safely, tick **I have stored these codes safely**, then press **Done**. Each recovery code works one time, if you lose your phone.

**Signing in with it** — after the password, enter the six-digit code and press **Verify**. If you lost your phone, open **Use a recovery code instead** and type a recovery code such as `abcde-fghij` into the same box.

**Required by the tenant** — if your administrator switched on *Require two-factor authentication for everyone in this tenant*, a user who has none is taken to the setup step right after the password, before a session exists.

**Lost your phone and your recovery codes?** An administrator with the right authority can **Reset two-factor** on your user (they must give a reason). That deletes your enrolment and recovery codes and ends all your sessions; you then set it up again.

## Roles, authorities and scope

Three ideas decide what you see. Knowing them explains most "why can't I…?" questions.

1. **Role** — a named bundle of permissions, such as *Buyer* or *Accountant*. Your administrator gives you one or more roles.
2. **Authority** (also called *capability*) — a single permission inside a role, such as `FIN.JOURNAL.POST` ("may post an accounting entry"). You never assign these yourself; the role carries them. The code is only shown to you when something is refused.
3. **Scope** — *whose* data you may reach. An authority says **what** you may do; **scope** says **where**:
   - **Company access** — the companies (company codes) whose data you may touch. A user with **no** company access reaches **no** company's business data — missing access never means "everything".
   - **Plant access** — optionally narrows you further to named plants of those companies (typical for plant-level clerks).

> [!WARNING]
> Holding an authority is **not enough** on its own. A buyer with the purchase-order authority but company access to company `1000` only will not see company `2000`'s orders. To the buyer, a document of another company simply **does not exist**.

**What you see on screen**

- The **menu shows only screens you are allowed to open.** If a screen is missing, you lack the authority for it.
- If you open a screen by typing its address, it shows *"This screen requires authority …. Ask an administrator to update your role."* — send that sentence to your administrator.
- A screen you may display but not change shows *"Read-only view. Changes require authority …"*.
- *"Plant X does not stand"* or *"… does not exist"* may mean the object is really missing **or** is outside your company or plant access. The system answers the same way on purpose.
- The top bar shows **Tenant**, your user name, and how many authorities you hold.

## The standard roles

Every tenant starts with roles like these (your administrator may add custom ones):

| Role | Typical work |
|---|---|
| **Buyer** | Purchase requisitions and orders, supplier prices |
| **Warehouse clerk** | Goods receipts, goods issues, stock checks |
| **Planner** | Material requirements planning, planned orders |
| **Production clerk** | Production orders, confirmations |
| **Sales clerk** | Sales orders, deliveries, billing |
| **Accountant** | Journal entries, supplier and customer accounts, month-end |
| **Controller** | Cost centres, internal orders, product costing |
| **Auditor** | Read-only access under a time-limited grant |
| **Configurator** | Company structure and system settings |
| **Administrator / Platform administrator** | Users, roles, access, tenants |

Some roles are **protected** (marked `PROTECTED` on the roles page) and cannot be edited, so the system always keeps a safe core.

## For administrators: users, roles and business access

These screens are in the **Administration** module under **Security & access**. You need the matching authority (`CFG.PLT.USER.MAINTAIN` for users and access, `CFG.PLT.ROLE.MAINTAIN` for roles).

### Create a user — `/platform/users`

1. Open **Central user administration**.
2. In **Create application account** fill in:

| Field | Mandatory? | Rule | Sample |
|---|---|---|---|
| **Username** | Mandatory | 3–40 characters | `mfarah` |
| **Full name** | Mandatory | 2–120 characters | `Mariam Farah` |
| **Email (optional)** | Optional | Needed for password-reset mails | `mariam.farah@example.com` |
| **Initial password** | Mandatory | At least 10 characters, with a letter and a digit | `Welcome2026x` |

3. Press **Create account**.
4. Open the new user (**Open** in the list) and give them a role, then business access.

### Look after a user — details page

- **Account active** — switch to *Inactive* to stop a leaver signing in.
- **Lock account and revoke sessions** / **Unlock account** — locking ends all current sessions; unlocking clears the failed-attempt counter but does not change the password.
- **Send reset link** — mails a password-reset link to the user.
- **Reset two-factor** — mandatory **Reason**, for users who lost their device.

The directory can be searched by **username, name or email**, and filtered by **Active / Inactive / Locked / Unlocked**.

### Roles — `/platform/roles`

- **Create a custom role:** **Role code** (mandatory), **Name** (mandatory), **Description** (optional). Then add authorities to it with **Find a capability** and **Registered capability**.
- **Assign an ordinary role to another user:** choose the **User** and the **Role** (both mandatory).
- The page also lists **Tenant roles**, **User-role assignments** and the **Capability catalogue**.

### Business access — `/platform/users/access`

1. Search for the user (**Find a user**).
2. **Grant company access:** choose a company, press **Grant company scope**.
3. *Optional:* **Grant plant access:** choose the company, then the plant, press **Grant plant scope**. A user with plant access reaches **only** those plants.
4. You cannot change your own access (the buttons are disabled for yourself). Existing access can be revoked with the red button beside it.

> [!NOTE]
> **What happens in the background?**
> Role and access changes are recorded with who made them and when. Locking or deactivating a user ends their open sessions at once.

## Signing out

Open the menu next to your name (top right) and choose **Sign out**. Do this on any shared computer.

---

**← Previous** [Master Index](../README.md) · **Next →** [Navigation guide](navigation-guide.md)
