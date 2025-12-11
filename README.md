# Discord Invite Tracker Bot

A Discord bot that tracks who invited whom and automatically manages roles for inviters based on the membership status and roles of their invitees.

## Features

- **Invitation Tracking**: Automatically tracks which user invited which member
- **Role Management**: Awards or removes roles from inviters based on their invitees' status
- **Real-time Updates**: Responds to members joining, leaving, and role changes
- **Persistent Storage**: Saves invitation data to a JSON file

## Setup

### 1. Prerequisites

- Node.js (v16.9.0 or higher)
- A Discord bot token

### 2. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to the "Bot" section and create a bot
4. Copy the bot token
5. Enable the following Privileged Gateway Intents:
   - Server Members Intent
   - Message Content Intent (if needed)
6. Invite the bot to your server with the following permissions:
   - Manage Roles
   - View Channels
   - Manage Invites

### 3. Install Dependencies

```bash
npm install
```

### 4. Configuration

1. Create `.env` file:

2. Edit `.env` and add your bot token:
   ```
   DISCORD_BOT_TOKEN=your_actual_bot_token_here
   ```

3. Edit `config.json` to configure which roles should be awarded:
   ```json
   {
     "roleConfigs": [
       {
         "roleId": "1234567890123456789",
         "roleName": "Inviter",
         "conditions": [
           {
             "type": "isMember",
             "description": "Award role when someone invites a member"
           }
         ]
       },
       {
         "roleId": "9876543210987654321",
         "roleName": "VIP Inviter",
         "conditions": [
           {
             "type": "hasRole",
             "roleId": "1111111111111111111",
             "roleName": "VIP",
             "description": "Award role when someone invites a member with VIP role"
           }
         ]
       }
     ]
   }
   ```

### Configuration Options

#### Role Configuration

Each role configuration has:
- `roleId`: The Discord role ID (optional, can use roleName instead)
- `roleName`: The Discord role name (optional, can use roleId instead)
- `conditions`: Array of conditions that must be met

#### Condition Types

1. **`isMember`**: Awards role when someone invites any member
   ```json
   {
     "type": "isMember"
   }
   ```

2. **`hasRole`**: Awards role when someone invites a member with a specific role
   ```json
   {
     "type": "hasRole",
     "roleId": "role_id_here",
     "roleName": "Role Name"
   }
   ```
   Note: You can use either `roleId` or `roleName` (or both)

### 5. Run the Bot

```bash
npm start
```

## How It Works

1. **Member Joins**: When a new member joins, the bot:
   - Compares current invites with previous invites to determine who invited them
   - Stores the invitation relationship
   - Checks if the inviter should receive any roles based on the invitee's status

2. **Member Leaves**: When a member leaves, the bot:
   - Removes them from the inviter's invitee list
   - Re-evaluates whether the inviter should keep their roles
   - Removes roles if no active invitees meet the conditions

3. **Role Changes**: When an invitee's roles change, the bot:
   - Re-evaluates the inviter's roles
   - Updates roles accordingly

## Data Storage

Invitation data is stored in `inviteData.json`. This file is automatically created and managed by the bot. The structure is:

```json
{
  "invites": {},
  "inviteCodes": {
    "guild_id": {
      "invite_code": {
        "uses": 5,
        "inviterId": "user_id",
        "code": "invite_code"
      }
    }
  },
  "memberInvites": {
    "inviter_user_id": ["invitee_user_id_1", "invitee_user_id_2"]
  }
}
```

## Important Notes

- The bot needs the "Manage Roles" permission and must be placed above the roles it manages in the role hierarchy
- The bot requires the "Server Members Intent" to track members
- Invitation tracking works by comparing invite usage counts, so it's most accurate when the bot is running continuously
- If the bot is offline when someone joins, it may not be able to determine who invited them

## Troubleshooting

- **Bot can't find inviter**: Make sure the bot has been running and tracking invites before members join
- **Roles not being awarded**: Check that the bot has "Manage Roles" permission and is above the target roles in the hierarchy
- **Permission errors**: Ensure the bot has all required intents enabled in the Discord Developer Portal

## License

MIT

