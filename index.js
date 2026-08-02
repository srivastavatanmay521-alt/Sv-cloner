require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (query) => new Promise((resolve) => rl.question(query, resolve));

const g = '\x1b[32m', r = '\x1b[31m', y = '\x1b[33m', c = '\x1b[36m', w = '\x1b[0m';
const log = (color, msg) => console.log(`${color}${msg}${w}`);
const success = (msg) => log(g, `[✓] ${msg}`);
const error = (msg) => log(r, `[✗] ${msg}`);
const info = (msg) => log(c, `[i] ${msg}`);
const warning = (msg) => log(y, `[!] ${msg}`);

const client = new Client({ checkUpdate: false });

let sourceGuild = null;
let targetGuild = null;
let roleMap = new Map();

// ============================================
// CLEAR TARGET SERVER
// ============================================
async function clearTemplate(guild) {
    warning(`\n⚠️ CLEARING ${guild.name}`);
    const confirm = await ask(`${y}Type "CONFIRM": ${w}`);
    if (confirm !== 'CONFIRM') return false;
    
    for (const emoji of guild.emojis.cache.values()) try { await emoji.delete(); } catch(e) {}
    for (const channel of guild.channels.cache.values()) try { await channel.delete(); } catch(e) {}
    for (const role of guild.roles.cache.values()) {
        if (role.name !== '@everyone') try { await role.delete(); } catch(e) {}
    }
    success("Target cleared!");
    return true;
}

// ============================================
// COPY ROLES
// ============================================
async function copyRoles(src, dst) {
    info(`Copying ${src.roles.cache.size} roles...`);
    roleMap.clear();
    
    const rolesToCopy = src.roles.cache
        .filter(role => role.name !== '@everyone')
        .sort((a, b) => b.position - a.position);
    
    for (const role of rolesToCopy.values()) {
        try {
            const newRole = await dst.roles.create({
                name: role.name,
                color: role.color,
                hoist: role.hoist,
                mentionable: role.mentionable,
                permissions: role.permissions
            });
            roleMap.set(role.id, newRole.id);
        } catch(e) {}
    }
    
    for (const role of rolesToCopy.values()) {
        const newRoleId = roleMap.get(role.id);
        if (newRoleId) {
            const newRole = dst.roles.cache.get(newRoleId);
            if (newRole) try { await newRole.edit({ position: role.position }); } catch(e) {}
        }
    }
    
    success(`Copied ${roleMap.size} roles`);
}

// ============================================
// CONVERT PERMISSIONS
// ============================================
function convertPermissionOverwrites(overwrites, srcGuild, dstGuild) {
    const result = [];
    
    for (const [id, overwrite] of overwrites) {
        let targetId = null;
        
        const sourceRole = srcGuild.roles.cache.get(id);
        if (sourceRole && roleMap.has(sourceRole.id)) {
            targetId = roleMap.get(sourceRole.id);
        }
        
        if (id === srcGuild.id) {
            targetId = dstGuild.id;
        }
        
        if (!targetId && srcGuild.members.cache.has(id)) {
            const member = srcGuild.members.cache.get(id);
            const targetMember = dstGuild.members.cache.get(member.id);
            if (targetMember) targetId = targetMember.id;
        }
        
        if (targetId) {
            let allow = overwrite.allow;
            let deny = overwrite.deny;
            
            if (typeof overwrite.allow === 'object' && overwrite.allow.bitfield !== undefined) {
                allow = overwrite.allow.bitfield;
            }
            if (typeof overwrite.deny === 'object' && overwrite.deny.bitfield !== undefined) {
                deny = overwrite.deny.bitfield;
            }
            
            result.push({
                id: targetId,
                allow: allow,
                deny: deny,
                type: overwrite.type
            });
        }
    }
    
    return result;
}

// ============================================
// COPY CHANNELS
// ============================================
async function copyChannels(src, dst) {
    info(`Copying channels with exact permissions...`);
    
    const categoryMap = new Map();
    const allChannels = Array.from(src.channels.cache.values());
    
    const categories = allChannels
        .filter(ch => ch.type === 'GUILD_CATEGORY')
        .sort((a, b) => a.position - b.position);
    
    for (const cat of categories) {
        try {
            const perms = convertPermissionOverwrites(cat.permissionOverwrites.cache, src, dst);
            
            const newCat = await dst.channels.create(cat.name, {
                type: 'GUILD_CATEGORY',
                position: cat.position,
                permissionOverwrites: perms
            });
            categoryMap.set(cat.id, newCat.id);
            success(`Created category: ${cat.name} with ${perms.length} permission overrides`);
        } catch(e) {
            error(`Failed category: ${cat.name}`);
        }
    }
    
    const nonCategories = allChannels
        .filter(ch => ch.type !== 'GUILD_CATEGORY')
        .sort((a, b) => a.position - b.position);
    
    let copied = 0;
    
    for (const ch of nonCategories) {
        try {
            const parentId = ch.parentId ? categoryMap.get(ch.parentId) : null;
            const channelType = ch.type === 'GUILD_TEXT' ? 'GUILD_TEXT' : 'GUILD_VOICE';
            
            const perms = convertPermissionOverwrites(ch.permissionOverwrites.cache, src, dst);
            
            const channelOptions = {
                type: channelType,
                parent: parentId,
                position: ch.position,
                permissionOverwrites: perms
            };
            
            if (ch.type === 'GUILD_TEXT') {
                channelOptions.topic = ch.topic || null;
                channelOptions.nsfw = ch.nsfw || false;
                channelOptions.rateLimitPerUser = ch.rateLimitPerUser || 0;
            }
            
            if (ch.type === 'GUILD_VOICE') {
                channelOptions.bitrate = ch.bitrate || 64000;
                channelOptions.userLimit = ch.userLimit || 0;
            }
            
            await dst.channels.create(ch.name, channelOptions);
            copied++;
            process.stdout.write(`\r${g}Progress: ${copied}/${nonCategories.length} channels (perms applied)${w}`);
        } catch(e) {
            error(`Failed: ${ch.name}`);
        }
    }
    console.log();
    success(`Copied ${copied} channels with EXACT permissions`);
}

// ============================================
// COPY EMOJIS
// ============================================
async function copyEmojis(src, dst) {
    info(`Copying ${src.emojis.cache.size} emojis...`);
    let copied = 0;
    
    for (const emoji of src.emojis.cache.values()) {
        try {
            const res = await fetch(emoji.url);
            const buf = await res.arrayBuffer();
            await dst.emojis.create({ attachment: Buffer.from(buf), name: emoji.name });
            copied++;
            process.stdout.write(`\r${g}Progress: ${copied}/${src.emojis.cache.size} emojis${w}`);
            if (copied % 5 === 0) await new Promise(r => setTimeout(r, 300));
        } catch(e) {}
    }
    console.log();
    success(`Copied ${copied} emojis`);
}

// ============================================
// COPY FULL TEMPLATE
// ============================================
async function copyFull(src, dst) {
    warning("\n══════ COPYING FULL TEMPLATE ══════");
    
    info("\n[1/3] Copying roles...");
    await copyRoles(src, dst);
    
    info("\n[2/3] Copying channels with exact permissions...");
    await copyChannels(src, dst);
    
    info("\n[3/3] Copying emojis...");
    await copyEmojis(src, dst);
    
    try { 
        await dst.edit({ name: src.name }); 
        success("Server name updated"); 
    } catch(e) {}
    
    if (src.iconURL()) {
        try {
            const res = await fetch(src.iconURL());
            const buf = await res.arrayBuffer();
            await dst.edit({ icon: Buffer.from(buf) });
            success("Server icon updated");
        } catch(e) {}
    }
    
    success("✅ Full template copied with ALL permissions!");
}

// ============================================
// MENU
// ============================================
async function showMenu() {
    console.clear();
    console.log(`${r}
    ██████╗ ███████╗██╗  ██╗         ██████╗  ██████╗  ██████╗ 
    ██╔══██╗██╔════╝╚██╗██╔╝        ██╔════╝ ██╔════╝ ██╔════╝ 
    ██████╔╝█████╗   ╚███╔╝         ███████╗ ███████╗ ███████╗ 
    ██╔══██╗██╔══╝   ██╔██╗         ██╔═══██╗██╔═══██╗██╔═══██╗
    ██║  ██║███████╗██╔╝ ██╗        ╚██████╔╝╚██████╔╝╚██████╔╝
    ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝         ╚═════╝  ╚═════╝  ╚═════╝ 
                                                               ${w}`);
    console.log(`${y}          SERVER CLONER TOOL${w}\n`);
    
    console.log(`${c}╔════════════════════════════════════════════════╗${w}`);
    console.log(`${c}║${g}  1. Copy Roles Only${c}                            ║${w}`);
    console.log(`${c}║${g}  2. Copy Channels (with hidden channels/perms)${c} ║${w}`);
    console.log(`${c}║${g}  3. Copy Emojis Only${c}                           ║${w}`);
    console.log(`${c}║${g}  4. Copy Full Template (ALL + Permissions)${c}     ║${w}`);
    console.log(`${c}║${r}  5. Clear Target Server${c}                        ║${w}`);
    console.log(`${c}║${y}  6. Change Servers${c}                             ║${w}`);
    console.log(`${c}║${r}  7. Exit${c}                                       ║${w}`);
    console.log(`${c}╚════════════════════════════════════════════════╝${w}`);
    
    console.log(`\n${y}Source: ${g}${sourceGuild ? sourceGuild.name : 'Not set'}${w}`);
    console.log(`${y}Target: ${g}${targetGuild ? targetGuild.name : 'Not set'}${w}\n`);
    
    return await ask(`${c}[?] SELECT (1-7) ~ ${w}`);
}

// ============================================
// SETUP
// ============================================
async function setupServers() {
    console.clear();
    console.log(`${r}
    ██████╗ ███████╗██╗  ██╗         ██████╗  ██████╗  ██████╗ 
    ██╔══██╗██╔════╝╚██╗██╔╝        ██╔════╝ ██╔════╝ ██╔════╝ 
    ██████╔╝█████╗   ╚███╔╝         ███████╗ ███████╗ ███████╗ 
    ██╔══██╗██╔══╝   ██╔██╗         ██╔═══██╗██╔═══██╗██╔═══██╗
    ██║  ██║███████╗██╔╝ ██╗        ╚██████╔╝╚██████╔╝╚██████╔╝
    ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝         ╚═════╝  ╚═════╝  ╚═════╝ 
                                                               ${w}`);
    console.log(`${y}          SERVER SETUP${w}\n`);
    
    const srcId = await ask(`${c}[?] Source Server ID ~ ${w}`);
    const src = client.guilds.cache.get(srcId);
    if (!src) { error("Source not found!"); return false; }
    sourceGuild = src;
    success(`Source: ${sourceGuild.name}`);
    
    const dstId = await ask(`${c}[?] Target Server ID ~ ${w}`);
    const dst = client.guilds.cache.get(dstId);
    if (!dst) { error("Target not found!"); return false; }
    targetGuild = dst;
    success(`Target: ${targetGuild.name}`);
    
    const confirm = await ask(`${y}[?] Copy "${sourceGuild.name}" → "${targetGuild.name}"? (y/n) ~ ${w}`);
    return confirm.toLowerCase() === 'y';
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.clear();

    const originalTitle = 'Rex † 666 srv cloner';
    process.title = originalTitle;
    setInterval(() => {
        if (process.title !== originalTitle) {
            console.log('\x1b[31m[TAMPER DETECTED] Shutting down...\x1b[0m');
            process.exit(1);
        }
    }, 100);
    
    const token = process.env.TOKEN;
    if (!token || token.length < 50) {
        error("Token not found in .env!");
        process.exit(1);
    }
    success("Token loaded");
    
    info("Logging in...");
    try { await client.login(token); } 
    catch(e) { error(`Login failed: ${e.message}`); process.exit(1); }
    
    await new Promise(r => setTimeout(r, 2000));
    success(`Logged in as ${client.user.tag}`);
    
    if (!await setupServers()) { client.destroy(); process.exit(0); }
    
    let running = true;
    while (running) {
        const choice = await showMenu();
        
        console.clear();
        console.log(`${c}${'═'.repeat(50)}${w}`);
        console.log(`${y}         OPERATION IN PROGRESS...${w}`);
        console.log(`${c}${'═'.repeat(50)}${w}\n`);
        
        switch(choice) {
            case '1': await copyRoles(sourceGuild, targetGuild); break;
            case '2': await copyChannels(sourceGuild, targetGuild); break;
            case '3': await copyEmojis(sourceGuild, targetGuild); break;
            case '4': await copyFull(sourceGuild, targetGuild); break;
            case '5': await clearTemplate(targetGuild); break;
            case '6': 
                if (!await setupServers()) warning("Setup failed");
                continue;
            case '7': running = false; break;
            default: error("Invalid option");
        }
        
        if (running && choice !== '6') {
            console.log(`\n${c}${'═'.repeat(50)}${w}`);
            await ask(`\n${g}Press Enter to continue...${w}`);
        }
    }
    
    client.destroy();
    process.exit(0);
}

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

main();