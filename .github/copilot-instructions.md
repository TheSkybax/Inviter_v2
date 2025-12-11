<!-- Copilot / AI agent instructions tailored to this repo -->
# Copilot Instructions — Discord Invite Tracker Bot

Purpose: Help AI coding agents quickly understand, modify, and extend the Discord invite-tracker bot in this repo.

- **Repo entry points**: `index.js` is the main application. `package.json` declares `start` -> `node index.js`.
- **Config & data**: `config.json` controls role rules; runtime persistent data lives in `inviteData.json` and `memberInvites.json`.

Architecture (short)
- Event-driven Discord bot using `discord.js` v14. Key events: `GuildMemberAdd`, `GuildMemberRemove`, `GuildMemberUpdate`, `InviteCreate`, `InviteDelete`.
- Invite tracking flow: the bot catalogs invites (`catalogueAllInvites`), compares invite uses to determine inviter (`findInviter`), then persists inviter→invitee mappings in `data.memberInvites` and `memberInvites.json`.
- Role logic is split into per-invitee checks and threshold rewards: see `updateInviterRoles` and `updateInviterThresholdRoles`.

Important patterns & project-specific conventions
- Persistent JSON model: the project stores state in root JSON files. Use the helper `loadInviteData()` and `saveInviteData()` when touching state to preserve the expected shape (they also keep `memberInvites.json` synchronized).
- memberInvites is authoritative for role rewards: do NOT clear `memberInvites` when invites expire/delete — the code intentionally keeps inviter→invitee lists across invite deletions.
- Role configuration supports both `roleId` and `roleName`. Condition objects often use `hasAnyRole` (see `config.json` roleConfigs) and `thresholdRewards` for n-of-matching-invitees behavior.
- Env loading: `.env` is loaded explicitly from the project root via `dotenv.config({ path: path.join(__dirname, '.env') })`. If `DISCORD_BOT_TOKEN` is missing the process exits early.

Key files & functions to inspect when making changes
- `index.js` — main logic. Read first.
  - Persistence: `loadInviteData`, `saveInviteData`, `saveMemberInvitesFile`
  - Invite discovery: `fetchInvites`, `findInviter`, `catalogueAllInvites`
  - Role assignment: `updateInviterRoles`, `updateInviterThresholdRoles`, `processInviterWithAllInvitees`, `applyRolesRetroactively`, `verifyAndMaintainRoleRewards`
- `config.json` — role rules format; use the same field names when adding new conditions.
- `inviteData.json` & `memberInvites.json` — live examples of storage shape; preserve compatibility when changing structure.

Developer workflows (project-specific)
- Install: `npm install` (requires Node >=16.9.0 per README). Packages: `discord.js` and `dotenv`.
- Configure token: copy `.env.example` → `.env` and set `DISCORD_BOT_TOKEN`.
  - Windows PowerShell example: `Copy-Item .env.example .env` or `copy .env.example .env`.
- Run: `npm start` (runs `node index.js`). The process will exit with error logging if `DISCORD_BOT_TOKEN` is missing.

Editing guidance for AI agents
- Prefer using existing helper functions when changing behavior (e.g., modifying persistence should update `saveInviteData` / `saveMemberInvitesFile`).
- If you change the JSON schema, update `loadInviteData()` fallback structure and the `saveMemberInvitesFile()` output format to avoid breaking existing data.
- When modifying role logic, keep in mind two independent systems: per-invitee role checks (`hasAnyRole`) and threshold rewards (`thresholdRewards`). Tests or manual checks should validate both paths.
- Be conservative with event handling changes — the bot depends on invite use diffing to attribute inviter. If you change invite attribution, validate with join/leave scenarios.

Debugging tips
- Missing token -> process exits. Check `.env` path printed by startup logs.
- Check `memberInvites.json` for persisted inviter→invitee lists; `saveMemberInvitesFile` writes a human-readable summary with `lastUpdated` and counts.
- Many operations log to console; reproduce issues by running locally and watching logs.

Small examples (how to add a new reward)
- Add a `roleConfigs` entry to `config.json` using `type: "hasAnyRole"` and include either `roleIds` or `roleNames`. For multi-invitee thresholds, add to `thresholdRewards` with `threshold: <number>`.

If something above is unclear or you'd like the instructions to emphasize other areas (tests, a CI setup, or contributing guidelines), tell me what to include and I will iterate.
