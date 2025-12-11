const { Client, GatewayIntentBits, Events, GuildMember, PermissionsBitField } = require('discord.js');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load .env file with explicit path
const envPath = path.join(__dirname, '.env');
const envResult = dotenv.config({ path: envPath });

if (envResult.error) {
    console.error('Error loading .env file:', envResult.error.message);
    console.log(`Looking for .env file at: ${envPath}`);
    if (!fsSync.existsSync(envPath)) {
        console.error('The .env file does not exist!');
        console.log('Please create a .env file with: DISCORD_BOT_TOKEN=your_token_here');
    }
}

// Initialize Discord client with necessary intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildMessages
    ]
});

// --- Remote logger: mirrors console output to a Discord channel (configurable)
const logQueue = [];
// Capture original console methods to avoid recursion when logger reports internal errors
const REAL_CONSOLE = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
};
let logChannel = null;
let logChannelReady = false;
let hasFlushedStartup = false;
let startupBatching = true;

function formatLogMessage(level, parts) {
    try {
        const body = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
        return `[${new Date().toISOString()}] [${level}] ${body}`;
    } catch (err) {
        return `[${new Date().toISOString()}] [${level}] (unserializable log)`;
    }
}

async function sendLogToChannel(text) {
    if (!logChannel || !logChannelReady) {
        return;
    }

    // Discord message limit; send in chunks
    const max = 1900;
    const chunks = [];
    for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));

    for (const chunk of chunks) {
        try {
            // Wrap in code block for readability
            await logChannel.send('```' + chunk + '```');
        } catch (error) {
            // If sending fails, stop trying to avoid spamming errors
            // Keep the message in queue for later attempts
            REAL_CONSOLE.error('Error sending log to channel:', error.message || error);
            return;
        }
    }
}

function flushLogQueue() {
    if (!logChannelReady || !logChannel) return;
    while (logQueue.length > 0) {
        const msg = logQueue.shift();
        // fire-and-forget; errors are handled in sendLogToChannel
        sendLogToChannel(msg).catch(() => {});
    }
}

// Send all queued startup logs as a single combined message (called after retroactive processing)
function flushStartupCombined() {
    if (hasFlushedStartup) return;
    if (!logChannelReady || !logChannel) {
        // can't send yet; leave queued
        return;
    }

    if (logQueue.length === 0) {
        hasFlushedStartup = true;
        startupBatching = false;
        return;
    }

    const combined = logQueue.join('\n');
    logQueue.length = 0;
    sendLogToChannel(combined).catch(() => {});
    hasFlushedStartup = true;
    startupBatching = false;
}

// Send a short confirmation to the configured logging channel if a similar entry
// is not already queued (prevents duplicate notifications).
function sendAdminActionConfirmation(text, inviterId, inviteeId) {
    try {
        if (!logChannelReady || !logChannel) return;

        // If the queued logs already contain both inviter and invitee IDs, skip sending
        const joined = logQueue.join(' ');
        if (inviterId && inviteeId && joined.includes(inviterId) && joined.includes(inviteeId)) {
            return;
        }

        // Send a short plaintext confirmation (not wrapped in a code block)
        logChannel.send(text).catch(err => REAL_CONSOLE.error('Failed to send admin confirmation to log channel:', err));
    } catch (error) {
        REAL_CONSOLE.error('sendAdminActionConfirmation error:', error);
    }
}

async function initRemoteLoggerFromConfig(config) {
    try {
        const logging = config?.logging;
        if (!logging || !logging.enabled || !logging.channelId) return;

        // Fetch channel reference
        logChannel = await client.channels.fetch(logging.channelId).catch(() => null);
        if (!logChannel) {
            REAL_CONSOLE.warn('Configured log channel not found or inaccessible:', logging.channelId);
            return;
        }
        logChannelReady = true;
        // Do not flush here; startup logs are batched until retroactive processing completes
        REAL_CONSOLE.log('Remote logger initialized for channel', logging.channelId);
    } catch (error) {
        REAL_CONSOLE.error('Failed to initialize remote logger:', error);
    }
}

// Override console methods to mirror output to the queue + original
const _origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
};

console.log = function (...args) {
    _origConsole.log(...args);
    try {
        const text = formatLogMessage('INFO', args);
        logQueue.push(text);
        if (logChannelReady && !startupBatching) flushLogQueue();
    } catch (e) {}
};

console.warn = function (...args) {
    _origConsole.warn(...args);
    try {
        const text = formatLogMessage('WARN', args);
        logQueue.push(text);
        if (logChannelReady && !startupBatching) flushLogQueue();
    } catch (e) {}
};

console.error = function (...args) {
    _origConsole.error(...args);
    try {
        const text = formatLogMessage('ERROR', args);
        logQueue.push(text);
        if (logChannelReady && !startupBatching) flushLogQueue();
    } catch (e) {}
};

// Data storage file
const DATA_FILE = path.join(__dirname, 'inviteData.json');
const MEMBER_INVITES_FILE = path.join(__dirname, 'memberInvites.json');

// Load invite data from file
async function loadInviteData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // File doesn't exist or is invalid, return default structure
        return {
            invites: {},
            inviteCodes: {}, // Tracks invite usage for detecting new joins
            memberInvites: {}, // PERSISTENT: Maps inviterId -> [inviteeIds]. This data persists independently of invite existence and maintains role rewards even if invites expire/delete
            inviteCatalogues: {} // Full catalogue of all active invites
        };
    }
}

// Save invite data to file
async function saveInviteData(data) {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    // Also save memberInvites to a separate readable file
    await saveMemberInvitesFile(data.memberInvites || {});
}

// Save memberInvites data to a separate readable file
async function saveMemberInvitesFile(memberInvites) {
    try {
        // Create a formatted version with metadata
        const formattedData = {
            lastUpdated: new Date().toISOString(),
            totalInviters: Object.keys(memberInvites).length,
            totalInvitees: Object.values(memberInvites).reduce((sum, arr) => sum + arr.length, 0),
            memberInvites: memberInvites,
            summary: {}
        };
        
        // Create summary with counts
        for (const [inviterId, inviteeIds] of Object.entries(memberInvites)) {
            formattedData.summary[inviterId] = {
                inviteeCount: inviteeIds.length,
                inviteeIds: inviteeIds
            };
        }
        
        await fs.writeFile(MEMBER_INVITES_FILE, JSON.stringify(formattedData, null, 2), 'utf8');
        
        // Verify file was created
        const fileExists = fsSync.existsSync(MEMBER_INVITES_FILE);
        if (fileExists) {
            console.log(`✓ memberInvites.json file saved successfully`);
        } else {
            console.warn(`⚠ Warning: memberInvites.json file may not have been created`);
        }
    } catch (error) {
        console.error('Error saving memberInvites file:', error);
        console.error(`File path attempted: ${MEMBER_INVITES_FILE}`);
    }
}

// Get all invites for a guild
async function fetchInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        const inviteMap = {};
        invites.forEach(invite => {
            inviteMap[invite.code] = {
                uses: invite.uses || 0,
                inviterId: invite.inviter?.id || null,
                code: invite.code
            };
        });
        return inviteMap;
    } catch (error) {
        console.error(`Error fetching invites for ${guild.name}:`, error);
        return {};
    }
}

// Find who invited a member
async function findInviter(member, oldInvites, newInvites) {
    for (const code in newInvites) {
        const oldInvite = oldInvites[code];
        const newInvite = newInvites[code];
        
        if (!oldInvite || newInvite.uses > oldInvite.uses) {
            return {
                inviterId: newInvite.inviterId,
                code: code
            };
        }
    }
    return null;
}

// Helper function to get a single role from ID or name
function getRoleFromConfig(guild, roleId, roleName) {
    if (roleId) {
        const role = guild.roles.cache.get(roleId);
        if (role) return role;
    }
    if (roleName) {
        const role = guild.roles.cache.find(r => r.name === roleName);
        if (role) return role;
    }
    return null;
}

// Helper function to get multiple roles from arrays (for required roles checking)
function getRequiredRoles(guild, roleIds, roleNames) {
    const roles = [];
    
    if (Array.isArray(roleIds)) {
        for (const roleId of roleIds) {
            if (roleId) {
                const role = guild.roles.cache.get(roleId);
                if (role && !roles.find(r => r.id === role.id)) roles.push(role);
            }
        }
    } else if (roleIds) {
        const role = guild.roles.cache.get(roleIds);
        if (role) roles.push(role);
    }
    
    if (Array.isArray(roleNames)) {
        for (const roleName of roleNames) {
            if (roleName) {
                const role = guild.roles.cache.find(r => r.name === roleName);
                if (role && !roles.find(r => r.id === role.id)) roles.push(role);
            }
        }
    } else if (roleNames) {
        const role = guild.roles.cache.find(r => r.name === roleNames);
        if (role && !roles.find(r => r.id === role.id)) roles.push(role);
    }
    
    return roles;
}

// Update inviter roles based on threshold count (3 invitees with any of the required roles)
// NOTE: Uses data.memberInvites which persists independently of invite existence
// Role rewards are maintained even if the original invite expires or is deleted
async function updateInviterThresholdRoles(inviterId, guild, config, data) {
    if (!inviterId) return;
    
    const inviter = await guild.members.fetch(inviterId).catch(() => null);
    if (!inviter) return;
    
    // Check threshold rewards configuration
    if (!config.thresholdRewards || !Array.isArray(config.thresholdRewards)) {
        return;
    }
    
    for (const thresholdConfig of config.thresholdRewards) {
        // Get single reward role
        const rewardRole = getRoleFromConfig(
            guild,
            thresholdConfig.rewardRoleId,
            thresholdConfig.rewardRoleName
        );
        
        // Get required roles (invitee needs at least one)
        const requiredRoles = getRequiredRoles(
            guild,
            thresholdConfig.requiredRoleId || thresholdConfig.requiredRoleIds,
            thresholdConfig.requiredRoleName || thresholdConfig.requiredRoleNames
        );
        
        if (!rewardRole || requiredRoles.length === 0) {
            console.warn(`Threshold reward role or required role not found`);
            continue;
        }
        
        // IMPORTANT: Uses memberInvites which persists even if invites are deleted/expired
        // Count how many invitees have at least one of the required roles
        const inviteeIds = data.memberInvites[inviterId] || [];
        let inviteesWithRole = 0;
        
        for (const inviteeId of inviteeIds) {
            try {
                const inviteeMember = await guild.members.fetch(inviteeId).catch(() => null);
                if (!inviteeMember) continue;
                
                const hasRequiredRole = requiredRoles.some(role => inviteeMember.roles.cache.has(role.id));
                if (hasRequiredRole) {
                    inviteesWithRole++;
                }
            } catch (error) {
                console.error(`Error checking invitee ${inviteeId}:`, error);
            }
        }
        
        const threshold = thresholdConfig.threshold || 3;
        const inviterHasRole = inviter.roles.cache.has(rewardRole.id);
        
        // Award role if count reaches threshold (3 or more)
        if (inviteesWithRole >= threshold && !inviterHasRole) {
            try {
                await inviter.roles.add(rewardRole);
                console.log(`Awarded threshold role ${rewardRole.name} to ${inviter.user.tag} (${inviteesWithRole} invitees with required role)`);
            } catch (error) {
                console.error(`Error adding threshold role to ${inviter.user.tag}:`, error);
            }
        }
        // Remove role if count goes below threshold (less than 3)
        else if (inviteesWithRole < threshold && inviterHasRole) {
            try {
                await inviter.roles.remove(rewardRole);
                console.log(`Removed threshold role ${rewardRole.name} from ${inviter.user.tag} (only ${inviteesWithRole} invitees with required role, need ${threshold})`);
            } catch (error) {
                console.error(`Error removing threshold role from ${inviter.user.tag}:`, error);
            }
        }
    }
}

// Check if invitee has any of the required roles
function inviteeHasAnyRole(invitee, requiredRoleIds, requiredRoleNames) {
    const inviteeRoles = invitee.roles.cache.map(role => role.id);
    const inviteeRoleNames = invitee.roles.cache.map(role => role.name);
    
    // Check by ID
    if (Array.isArray(requiredRoleIds)) {
        const hasAnyById = requiredRoleIds.some(roleId => roleId && inviteeRoles.includes(roleId));
        if (hasAnyById) return true;
    } else if (requiredRoleIds && inviteeRoles.includes(requiredRoleIds)) {
        return true;
    }
    
    // Check by name
    if (Array.isArray(requiredRoleNames)) {
        const hasAnyByName = requiredRoleNames.some(roleName => roleName && inviteeRoleNames.includes(roleName));
        if (hasAnyByName) return true;
    } else if (requiredRoleNames && inviteeRoleNames.includes(requiredRoleNames)) {
        return true;
    }
    
    return false;
}

// Update inviter roles based on invitee
// NOTE: This function uses data.memberInvites which persists independently of invite existence
// Role rewards are maintained even if the original invite expires or is deleted
async function updateInviterRoles(inviterId, invitee, guild, config, data, isJoining = true) {
    if (!inviterId) return;
    
    const inviter = await guild.members.fetch(inviterId).catch(() => null);
    if (!inviter) return;
    
    // Check each role configuration
    if (!config.roleConfigs || !Array.isArray(config.roleConfigs)) {
        await updateInviterThresholdRoles(inviterId, guild, config, data);
        return;
    }
    
    for (const roleConfig of config.roleConfigs) {
        // Only support hasAnyRole condition type
        const hasAnyRoleCondition = roleConfig.conditions?.find(c => c.type === 'hasAnyRole');
        if (!hasAnyRoleCondition) continue;
        
        // Get single reward role
        const rewardRole = getRoleFromConfig(
            guild,
            roleConfig.roleId,
            roleConfig.roleName
        );
        
        if (!rewardRole) {
            console.warn(`Reward role not found: ${roleConfig.roleId || roleConfig.roleName}`);
            continue;
        }
        
        // Get required roles
        const requiredRoleIds = hasAnyRoleCondition.roleIds || (hasAnyRoleCondition.roleId ? [hasAnyRoleCondition.roleId] : []);
        const requiredRoleNames = hasAnyRoleCondition.roleNames || (hasAnyRoleCondition.roleName ? [hasAnyRoleCondition.roleName] : []);
        
        if (requiredRoleIds.length === 0 && requiredRoleNames.length === 0) {
            console.warn(`No required roles specified in hasAnyRole condition`);
            continue;
        }
        
        const inviteeMeetsCondition = inviteeHasAnyRole(invitee, requiredRoleIds, requiredRoleNames);
        const inviterHasRole = inviter.roles.cache.has(rewardRole.id);
        
        if (inviteeMeetsCondition && isJoining) {
            // Award role to inviter
            if (!inviterHasRole) {
                try {
                    await inviter.roles.add(rewardRole);
                    console.log(`Awarded role ${rewardRole.name} to ${inviter.user.tag} for inviting ${invitee.user.tag}`);
                } catch (error) {
                    console.error(`Error adding role to ${inviter.user.tag}:`, error);
                }
            }
        } else if (!inviteeMeetsCondition || !isJoining) {
            // Check if inviter should lose the role
            // IMPORTANT: Uses data.memberInvites which persists even if invites are deleted/expired
            // Count how many invitees still meet the condition
            const inviteeIds = data.memberInvites[inviterId] || [];
            let activeInvitees = 0;
            
            for (const inviteeId of inviteeIds) {
                try {
                    const inviteeMember = await guild.members.fetch(inviteeId).catch(() => null);
                    if (!inviteeMember) continue;
                    
                    if (inviteeHasAnyRole(inviteeMember, requiredRoleIds, requiredRoleNames)) {
                        activeInvitees++;
                    }
                } catch (error) {
                    console.error(`Error checking invitee ${inviteeId}:`, error);
                }
            }
            
            // Remove role if no active invitees meet the condition
            if (activeInvitees === 0 && inviterHasRole) {
                try {
                    await inviter.roles.remove(rewardRole);
                    console.log(`Removed role ${rewardRole.name} from ${inviter.user.tag} (no active invitees)`);
                } catch (error) {
                    console.error(`Error removing role from ${inviter.user.tag}:`, error);
                }
            }
        }
    }
    
    // Also check threshold rewards (also uses memberInvites, independent of invite existence)
    await updateInviterThresholdRoles(inviterId, guild, config, data);
}

// Catalogue all active invites in a guild
async function catalogueAllInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        const inviteCatalogue = {};
        
        invites.forEach(invite => {
            inviteCatalogue[invite.code] = {
                code: invite.code,
                inviterId: invite.inviter?.id || null,
                inviterTag: invite.inviter?.tag || null,
                uses: invite.uses || 0,
                maxUses: invite.maxUses || null,
                expiresAt: invite.expiresAt?.getTime() || null,
                createdAt: invite.createdAt?.getTime() || null,
                temporary: invite.temporary || false,
                channelId: invite.channel?.id || null,
                channelName: invite.channel?.name || null
            };
        });
        
        return inviteCatalogue;
    } catch (error) {
        console.error(`Error cataloguing invites for ${guild.name}:`, error);
        return {};
    }
}

// Verify and maintain role rewards for an inviter (used when invites are deleted/expired)
async function verifyAndMaintainRoleRewards(inviterId, guild, config, data) {
    if (!inviterId) return;
    
    const inviteeIds = data.memberInvites[inviterId] || [];
    if (inviteeIds.length === 0) return;
    
    // Fetch all current invitees still in the guild
    const invitees = [];
    for (const inviteeId of inviteeIds) {
        try {
            const inviteeMember = await guild.members.fetch(inviteeId).catch(() => null);
            if (inviteeMember) {
                invitees.push(inviteeMember);
            }
        } catch (error) {
            // Member not found or left, skip
        }
    }
    
    if (invitees.length === 0) return;
    
    // Process with all invitees to maintain role rewards
    await processInviterWithAllInvitees(inviterId, invitees, guild, config, data);
}

// Process all invitees for an inviter and update roles accordingly
async function processInviterWithAllInvitees(inviterId, invitees, guild, config, data) {
    if (!inviterId || invitees.length === 0) return;
    
    const inviter = await guild.members.fetch(inviterId).catch(() => null);
    if (!inviter) return;
    
    // Process roleConfigs
    if (config.roleConfigs && Array.isArray(config.roleConfigs)) {
        for (const roleConfig of config.roleConfigs) {
            const hasAnyRoleCondition = roleConfig.conditions?.find(c => c.type === 'hasAnyRole');
            if (!hasAnyRoleCondition) continue;
            
            const rewardRole = getRoleFromConfig(
                guild,
                roleConfig.roleId,
                roleConfig.roleName
            );
            
            if (!rewardRole) continue;
            
            const requiredRoleIds = hasAnyRoleCondition.roleIds || (hasAnyRoleCondition.roleId ? [hasAnyRoleCondition.roleId] : []);
            const requiredRoleNames = hasAnyRoleCondition.roleNames || (hasAnyRoleCondition.roleName ? [hasAnyRoleCondition.roleName] : []);
            
            if (requiredRoleIds.length === 0 && requiredRoleNames.length === 0) continue;
            
            // Check if any invitee meets the condition
            let anyInviteeMeetsCondition = false;
            for (const invitee of invitees) {
                if (inviteeHasAnyRole(invitee, requiredRoleIds, requiredRoleNames)) {
                    anyInviteeMeetsCondition = true;
                    break;
                }
            }
            
            const inviterHasRole = inviter.roles.cache.has(rewardRole.id);
            
            // Award role if any invitee meets condition
            if (anyInviteeMeetsCondition && !inviterHasRole) {
                try {
                    await inviter.roles.add(rewardRole);
                    console.log(`Retroactively awarded role ${rewardRole.name} to ${inviter.user.tag}`);
                } catch (error) {
                    console.error(`Error adding role to ${inviter.user.tag}:`, error);
                }
            }
            // Remove role if no invitees meet condition
            else if (!anyInviteeMeetsCondition && inviterHasRole) {
                try {
                    await inviter.roles.remove(rewardRole);
                    console.log(`Retroactively removed role ${rewardRole.name} from ${inviter.user.tag} (no active invitees)`);
                } catch (error) {
                    console.error(`Error removing role from ${inviter.user.tag}:`, error);
                }
            }
        }
    }
    
    // Process threshold rewards (this already checks all invitees)
    await updateInviterThresholdRoles(inviterId, guild, config, data);
}

// Retroactively apply roles to all inviters based on their current invitees
async function applyRolesRetroactively(guild, config, data) {
    console.log(`Applying roles retroactively for ${guild.name}...`);
    
    try {
        // Get all members in the guild
        await guild.members.fetch();
        
        // Get all invitees for each inviter
        const inviterMap = {};
        
        for (const [inviterId, inviteeIds] of Object.entries(data.memberInvites || {})) {
            if (!inviterMap[inviterId]) {
                inviterMap[inviterId] = [];
            }
            
            // Filter to only include members still in the guild
            for (const inviteeId of inviteeIds) {
                try {
                    const inviteeMember = await guild.members.fetch(inviteeId).catch(() => null);
                    if (inviteeMember) {
                        inviterMap[inviterId].push(inviteeMember);
                    }
                } catch (error) {
                    // Member not found, skip
                }
            }
        }
        
        // Apply role logic for each inviter (process once per inviter with all their invitees)
        let processedCount = 0;
        for (const [inviterId, invitees] of Object.entries(inviterMap)) {
            if (invitees.length === 0) continue;
            
            await processInviterWithAllInvitees(inviterId, invitees, guild, config, data);
            processedCount++;
        }
        
        console.log(`Retroactively processed ${processedCount} inviters with ${Object.values(inviterMap).reduce((sum, arr) => sum + arr.length, 0)} total invitees in ${guild.name}`);
    } catch (error) {
        console.error(`Error applying roles retroactively for ${guild.name}:`, error);
    }
}

// Main bot logic
client.once(Events.ClientReady, async () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    
    // Initialize memberInvites file immediately (create empty file if no data exists)
    const initialData = await loadInviteData();
    await saveMemberInvitesFile(initialData.memberInvites || {});
    console.log(`MemberInvites file initialized at ${MEMBER_INVITES_FILE}`);
    
    // Load config and initialize remote logger (once)
    const config = await loadConfig();
    await initRemoteLoggerFromConfig(config);

    // Register slash commands (guild-scoped) for each guild if missing
    async function ensureAdminCommands(guild) {
        try {
            const existing = await guild.commands.fetch();
            const foundAdd = existing.find(c => c.name === 'add-invite');
            const foundRemove = existing.find(c => c.name === 'remove-invite');

            if (!foundAdd) {
                await guild.commands.create({
                    name: 'add-invite',
                    description: 'Manually add an inviter -> invitee relationship (admin only)',
                    options: [
                        { name: 'inviter', type: 6, description: 'The user who invited', required: true },
                        { name: 'invitee', type: 6, description: 'The user who was invited', required: true }
                    ]
                });
                REAL_CONSOLE.log(`Registered /add-invite command for guild ${guild.id}`);
            }

            if (!foundRemove) {
                await guild.commands.create({
                    name: 'remove-invite',
                    description: 'Remove an inviter -> invitee mapping (admin only)',
                    options: [
                        { name: 'inviter', type: 6, description: 'The inviter user', required: true },
                        { name: 'invitee', type: 6, description: 'The invitee user to remove', required: true }
                    ]
                });
                REAL_CONSOLE.log(`Registered /remove-invite command for guild ${guild.id}`);
            }

            const foundList = existing.find(c => c.name === 'list-invites');
            if (!foundList) {
                await guild.commands.create({
                    name: 'list-invites',
                    description: 'List all invitees for a given inviter (admin only)',
                    options: [
                        { name: 'inviter', type: 6, description: 'The inviter user', required: true }
                    ]
                });
                REAL_CONSOLE.log(`Registered /list-invites command for guild ${guild.id}`);
            }
        } catch (error) {
            REAL_CONSOLE.error('Failed to register admin commands for', guild.id, error);
        }
    }

    // Initialize invite tracking and apply roles retroactively for all guilds
    for (const guild of client.guilds.cache.values()) {
        // ensure admin slash commands exist for this guild
        await ensureAdminCommands(guild).catch(() => {});
        try {
            const data = await loadInviteData();

            // Catalogue all active invites
            console.log(`Cataloguing all active invites for ${guild.name}...`);
            const inviteCatalogue = await catalogueAllInvites(guild);
            data.inviteCodes[guild.id] = inviteCatalogue;

            // Store full invite catalogue
            if (!data.inviteCatalogues) {
                data.inviteCatalogues = {};
            }
            data.inviteCatalogues[guild.id] = inviteCatalogue;

            await saveInviteData(data);
            console.log(`Catalogued ${Object.keys(inviteCatalogue).length} active invites for ${guild.name}`);
            console.log(`MemberInvites data saved to ${MEMBER_INVITES_FILE}`);

            // Apply roles retroactively
            await applyRolesRetroactively(guild, config, data);
        } catch (error) {
            console.error(`Error initializing invites for ${guild.name}:`, error);
        }
    }
    // After retroactive processing for all guilds, send combined startup logs (if configured)
    try {
        flushStartupCombined();
    } catch (e) {
        REAL_CONSOLE.error('Error flushing startup logs:', e);
    }
});

client.on(Events.GuildMemberAdd, async (member) => {
    const guild = member.guild;
    const data = await loadInviteData();
    
    // Get current invites
    const newInvites = await fetchInvites(guild);
    const oldInvites = data.inviteCodes[guild.id] || {};
    
    // Update invite catalogue
    const inviteCatalogue = await catalogueAllInvites(guild);
    if (!data.inviteCatalogues) {
        data.inviteCatalogues = {};
    }
    data.inviteCatalogues[guild.id] = inviteCatalogue;
    
    // Find who invited this member
    const inviterInfo = await findInviter(member, oldInvites, newInvites);
    
    if (inviterInfo && inviterInfo.inviterId) {
        // Store the invitation
        if (!data.memberInvites[inviterInfo.inviterId]) {
            data.memberInvites[inviterInfo.inviterId] = [];
        }
        data.memberInvites[inviterInfo.inviterId].push(member.id);
        
        // Update invite codes
        data.inviteCodes[guild.id] = newInvites;
        await saveInviteData(data);
        
        console.log(`${member.user.tag} was invited by ${inviterInfo.inviterId} (code: ${inviterInfo.code})`);
        
        // Load config and update inviter roles
        const config = await loadConfig();
        await updateInviterRoles(inviterInfo.inviterId, member, guild, config, data, true);
    } else {
        // Update invite codes even if we couldn't find the inviter
        data.inviteCodes[guild.id] = newInvites;
        await saveInviteData(data);
        console.log(`Could not determine who invited ${member.user.tag}`);
    }
});

client.on(Events.GuildMemberRemove, async (member) => {
    const guild = member.guild;
    const data = await loadInviteData();
    
    // Find who invited this member
    let inviterId = null;
    for (const [inviter, invitees] of Object.entries(data.memberInvites)) {
        if (invitees.includes(member.id)) {
            inviterId = inviter;
            // Remove from invitee list
            data.memberInvites[inviter] = invitees.filter(id => id !== member.id);
            break;
        }
    }
    
    if (inviterId) {
        await saveInviteData(data);
        console.log(`${member.user.tag} left. They were invited by ${inviterId}`);
        
        // Update inviter roles
        const config = await loadConfig();
        await updateInviterRoles(inviterId, member, guild, config, data, false);
    }
});

// Handle slash command interactions (add-invite)
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'add-invite') {
        // Permission check: require ADMINISTRATOR or ManageGuild
        const member = interaction.member;
        if (!member || !member.permissions) {
            await interaction.reply({ content: 'Unable to verify permissions.', ephemeral: true });
            return;
        }

        const hasPerm = member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!hasPerm) {
            await interaction.reply({ content: 'You need Administrator or Manage Guild permission to run this command.', ephemeral: true });
            return;
        }

        const inviterUser = interaction.options.getUser('inviter');
        const inviteeUser = interaction.options.getUser('invitee');
        if (!inviterUser || !inviteeUser) {
            await interaction.reply({ content: 'Both inviter and invitee must be provided.', ephemeral: true });
            return;
        }

        const guild = interaction.guild;
        if (!guild) {
            await interaction.reply({ content: 'This command must be used in a guild.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const data = await loadInviteData();
            // Ensure inviter array exists
            if (!data.memberInvites[inviterUser.id]) data.memberInvites[inviterUser.id] = [];

            // Avoid duplicates
            if (!data.memberInvites[inviterUser.id].includes(inviteeUser.id)) {
                data.memberInvites[inviterUser.id].push(inviteeUser.id);
                await saveInviteData(data);
            }

            // Try to fetch guild members for role updates
            const inviteeMember = await guild.members.fetch(inviteeUser.id).catch(() => null);
            const config = await loadConfig();

            // Update inviter roles retroactively based on this invitee
            await updateInviterRoles(inviterUser.id, inviteeMember || { id: inviteeUser.id, user: inviteeUser, roles: { cache: new Map() } }, guild, config, data, true);

            await interaction.editReply({ content: `Recorded inviter <@${inviterUser.id}> → invitee <@${inviteeUser.id}> and updated roles.` });

            // Send confirmation to logging channel if appropriate
            try {
                const confirmText = `✅ /add-invite by ${interaction.user.tag}: <@${inviterUser.id}> → <@${inviteeUser.id}>`;
                sendAdminActionConfirmation(confirmText, inviterUser.id, inviteeUser.id);
            } catch (e) {
                REAL_CONSOLE.error('Error sending add-invite confirmation:', e);
            }
        } catch (error) {
            REAL_CONSOLE.error('Error processing add-invite command:', error);
            await interaction.editReply({ content: `Failed to add invite mapping: ${error.message || error}`, ephemeral: true });
        }
    }
    else if (interaction.commandName === 'remove-invite') {
        // Permission check: require ADMINISTRATOR or ManageGuild
        const member = interaction.member;
        if (!member || !member.permissions) {
            await interaction.reply({ content: 'Unable to verify permissions.', ephemeral: true });
            return;
        }

        const hasPerm = member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!hasPerm) {
            await interaction.reply({ content: 'You need Administrator or Manage Guild permission to run this command.', ephemeral: true });
            return;
        }

        const inviterUser = interaction.options.getUser('inviter');
        const inviteeUser = interaction.options.getUser('invitee');
        if (!inviterUser || !inviteeUser) {
            await interaction.reply({ content: 'Both inviter and invitee must be provided.', ephemeral: true });
            return;
        }

        const guild = interaction.guild;
        if (!guild) {
            await interaction.reply({ content: 'This command must be used in a guild.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const data = await loadInviteData();
            const arr = data.memberInvites[inviterUser.id] || [];
            if (arr.includes(inviteeUser.id)) {
                data.memberInvites[inviterUser.id] = arr.filter(id => id !== inviteeUser.id);
                await saveInviteData(data);

                // Try to fetch guild member for role updates
                const inviteeMember = await guild.members.fetch(inviteeUser.id).catch(() => null);
                const config = await loadConfig();

                // Update inviter roles (treat as leave/remove)
                await updateInviterRoles(inviterUser.id, inviteeMember || { id: inviteeUser.id, user: inviteeUser, roles: { cache: new Map() } }, guild, config, data, false);

                await interaction.editReply({ content: `Removed mapping for inviter <@${inviterUser.id}> → invitee <@${inviteeUser.id}> and updated roles.` });

                // Send confirmation to logging channel if appropriate
                try {
                    const confirmText = `🗑️ /remove-invite by ${interaction.user.tag}: <@${inviterUser.id}> → <@${inviteeUser.id}>`;
                    sendAdminActionConfirmation(confirmText, inviterUser.id, inviteeUser.id);
                } catch (e) {
                    REAL_CONSOLE.error('Error sending remove-invite confirmation:', e);
                }
            } else {
                await interaction.editReply({ content: `No mapping found for inviter <@${inviterUser.id}> → invitee <@${inviteeUser.id}>.`, ephemeral: true });
            }
        } catch (error) {
            REAL_CONSOLE.error('Error processing remove-invite command:', error);
            await interaction.editReply({ content: `Failed to remove invite mapping: ${error.message || error}`, ephemeral: true });
        }
    }
    else if (interaction.commandName === 'list-invites') {
        // Permission check: require ADMINISTRATOR or ManageGuild
        const member = interaction.member;
        if (!member || !member.permissions) {
            await interaction.reply({ content: 'Unable to verify permissions.', ephemeral: true });
            return;
        }

        const hasPerm = member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (!hasPerm) {
            await interaction.reply({ content: 'You need Administrator or Manage Guild permission to run this command.', ephemeral: true });
            return;
        }

        const inviterUser = interaction.options.getUser('inviter');
        if (!inviterUser) {
            await interaction.reply({ content: 'Inviter user must be provided.', ephemeral: true });
            return;
        }

        const guild = interaction.guild;
        if (!guild) {
            await interaction.reply({ content: 'This command must be used in a guild.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const data = await loadInviteData();
            const inviteeIds = data.memberInvites[inviterUser.id] || [];

            if (inviteeIds.length === 0) {
                await interaction.editReply({ content: `No invitees found for <@${inviterUser.id}>.` });
                return;
            }

            // Fetch invitee members and build a list
            const inviteeList = [];
            for (const inviteeId of inviteeIds) {
                try {
                    const inviteeMember = await guild.members.fetch(inviteeId).catch(() => null);
                    if (inviteeMember) {
                        inviteeList.push(`<@${inviteeMember.id}> (${inviteeMember.user.tag})`);
                    } else {
                        inviteeList.push(`<@${inviteeId}> (not in guild)`);
                    }
                } catch (e) {
                    inviteeList.push(`ID: ${inviteeId} (error fetching)`);
                }
            }

            const listText = inviteeList.join('\n');
            const message = `**Invitees for <@${inviterUser.id}>** (${inviteeIds.length} total):\n${listText}`;

            // If message is too long, split into chunks
            if (message.length > 2000) {
                const lines = message.split('\n');
                let current = '';
                for (const line of lines) {
                    if ((current + line).length > 1990) {
                        await interaction.followUp({ content: current, ephemeral: true });
                        current = '';
                    }
                    current += line + '\n';
                }
                if (current.trim()) {
                    await interaction.followUp({ content: current, ephemeral: true });
                }
                // Edit initial reply to indicate multi-message response
                await interaction.editReply({ content: '(see messages below)' });
            } else {
                await interaction.editReply({ content: message });
            }
        } catch (error) {
            REAL_CONSOLE.error('Error processing list-invites command:', error);
            await interaction.editReply({ content: `Failed to list invitees: ${error.message || error}`, ephemeral: true });
        }
    }
});

// Handle role updates on invitees
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    // Check if roles changed
    const oldRoles = oldMember.roles.cache.map(r => r.id).sort();
    const newRoles = newMember.roles.cache.map(r => r.id).sort();
    
    if (JSON.stringify(oldRoles) !== JSON.stringify(newRoles)) {
        const data = await loadInviteData();
        
        // Find who invited this member
        let inviterId = null;
        for (const [inviter, invitees] of Object.entries(data.memberInvites)) {
            if (invitees.includes(newMember.id)) {
                inviterId = inviter;
                break;
            }
        }
        
        if (inviterId) {
            const config = await loadConfig();
            await updateInviterRoles(inviterId, newMember, newMember.guild, config, data, true);
        }
    }
});

// Handle invite creation/updates/deletions to keep catalogue updated
client.on(Events.InviteCreate, async (invite) => {
    const guild = invite.guild;
    const data = await loadInviteData();
    
    // Update invite catalogue
    const inviteCatalogue = await catalogueAllInvites(guild);
    if (!data.inviteCatalogues) {
        data.inviteCatalogues = {};
    }
    data.inviteCatalogues[guild.id] = inviteCatalogue;
    await saveInviteData(data);
    
    console.log(`Invite created/updated: ${invite.code} by ${invite.inviter?.tag || 'Unknown'}`);
});

client.on(Events.InviteDelete, async (invite) => {
    const guild = invite.guild;
    const data = await loadInviteData();
    
    // Update invite catalogue
    const inviteCatalogue = await catalogueAllInvites(guild);
    if (!data.inviteCatalogues) {
        data.inviteCatalogues = {};
    }
    data.inviteCatalogues[guild.id] = inviteCatalogue;
    
    // IMPORTANT: memberInvites data persists independently of invite existence
    // Role rewards are maintained based on memberInvites, not invite codes
    // Do NOT clear memberInvites when invites are deleted
    
    await saveInviteData(data);
    
    console.log(`Invite deleted: ${invite.code} - Role rewards will be maintained based on tracked invitees`);
    
    // Verify and maintain role rewards for the inviter if they had invitees via this invite
    if (invite.inviter?.id) {
        const inviterId = invite.inviter.id;
        const inviteeIds = data.memberInvites[inviterId] || [];
        
        if (inviteeIds.length > 0) {
            // Re-verify role rewards are still correct after invite deletion
            const config = await loadConfig();
            await verifyAndMaintainRoleRewards(inviterId, guild, config, data);
        }
    }
});

// Load configuration
async function loadConfig() {
    try {
        const configData = await fs.readFile(path.join(__dirname, 'config.json'), 'utf8');
        return JSON.parse(configData);
    } catch (error) {
        console.error('Error loading config.json, using default config:', error);
        return {
            roleConfigs: [],
            thresholdRewards: []
        };
    }
}

// Login to Discord
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
    console.error('DISCORD_BOT_TOKEN is not set in .env file!');
    console.log('\nTroubleshooting:');
    console.log('1. Make sure you have a .env file in the project root');
    console.log('2. The .env file should contain: DISCORD_BOT_TOKEN=your_token_here');
    console.log('3. Make sure there are no spaces around the = sign');
    console.log('4. Make sure there are no quotes around the token value');
    console.log(`5. Current .env file path: ${envPath}`);
    console.log(`6. .env file exists: ${fsSync.existsSync(envPath)}`);
    if (fsSync.existsSync(envPath)) {
        console.log('7. .env file contents (first 50 chars):', fsSync.readFileSync(envPath, 'utf8').substring(0, 50));
    }
    process.exit(1);
}

client.login(token);

