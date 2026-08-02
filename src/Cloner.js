const { downloadImage, delay, handleRateLimit } = require('./utils/functions');
const log = require('./utils/logger');

class ServerCloner {
    constructor(client) {
        this.client = client;
        this.roleMapping = new Map();
        this.stats = {
            rolesCreated: 0,
            categoriesCreated: 0,
            channelsCreated: 0,
            emojisCreated: 0,
            failed: 0
        };
    }

    sendProgress(message, progressChannel) {
        if (progressChannel) {
            progressChannel.send(message).catch(() => {
                log.warning(`Failed to send progress message to channel: ${progressChannel.name}`);
            });
        }
        
        if (message.includes('❌') || message.includes('[-]')) {
            log.error(message.replace(/[:a-zA-Z_0-9\s]*$/, '').trim());
        } else if (message.includes('✅') || message.includes('[+]')) {
            log.success(message.replace(/[:a-zA-Z_0-9\s]*$/, '').trim());
        } else if (message.includes('📊') || message.includes('📈') || message.includes('[i]')) {
            log.info(message.replace(/[:a-zA-Z_0-9\s]*$/, '').trim());
        } else {
            console.log(message);
        }
    }

    async cloneServer(sourceGuildId, targetGuildId, cloneEmojis = true, progressChannel = null) {
        try {
            const sourceGuild = this.client.guilds.cache.get(sourceGuildId);
            const targetGuild = this.client.guilds.cache.get(targetGuildId);

            if (!sourceGuild) throw new Error('Source server not found! Make sure you are a member.');
            if (!targetGuild) throw new Error('Target server not found! Make sure you have admin permissions.');

            this.sendProgress(`Cloning from: ${sourceGuild.name} -> ${targetGuild.name}`, progressChannel);
            
            try {
                await this.deleteExistingContent(targetGuild, progressChannel);
                await delay(1000);
            } catch (error) {
                this.sendProgress(`⚠️ Warning during cleanup: ${error.message}`, progressChannel);
                log.warning(`Cleanup warning: ${error.message}`);
            }
            
            try {
                await this.cloneRoles(sourceGuild, targetGuild, progressChannel);
                await delay(1000);
            } catch (error) {
                this.sendProgress(`❌ Critical error during role cloning: ${error.message}`, progressChannel);
                throw error;
            }
            
            try {
                await this.cloneCategories(sourceGuild, targetGuild, progressChannel);
                await delay(1000);
            } catch (error) {
                this.sendProgress(`❌ Critical error during category cloning: ${error.message}`, progressChannel);
                throw error;
            }
            
            try {
                await this.cloneChannels(sourceGuild, targetGuild, progressChannel);
                await delay(1000);
            } catch (error) {
                this.sendProgress(`❌ Critical error during channel cloning: ${error.message}`, progressChannel);
                throw error;
            }
            
            if (cloneEmojis) {
                try {
                    await this.cloneEmojis(sourceGuild, targetGuild, progressChannel);
                    await delay(1000);
                } catch (error) {
                    this.sendProgress(`⚠️ Warning during emoji cloning: ${error.message}`, progressChannel);
                    log.warning(`Emoji cloning warning: ${error.message}`);
                }
            }
            
            try {
                await this.cloneServerInfo(sourceGuild, targetGuild, progressChannel);
            } catch (error) {
                this.sendProgress(`⚠️ Warning during server info cloning: ${error.message}`, progressChannel);
                log.warning(`Server info cloning warning: ${error.message}`);
            }

            this.showStats(progressChannel);
            this.sendProgress('🎉 Server cloning completed successfully!', progressChannel);

        } catch (error) {
            this.sendProgress(`❌ Cloning failed: ${error.message}`, progressChannel);
            log.error(error.stack);
            throw error;
        }
    }
    
    async deleteExistingContent(guild, progressChannel) {
        this.sendProgress('🗑️  Deleting existing content...', progressChannel);
        for (const [, channel] of guild.channels.cache) {
            try {
                if(channel.deletable) {
                    await channel.delete();
                    await delay(100);
                }
            } catch (error) {
                this.stats.failed++;
            }
        }

        for (const [, role] of guild.roles.cache) {
            try {
                if (role.name !== '@everyone' && !role.managed && role.editable) {
                    await role.delete();
                    await delay(100);
                }
            } catch (error) {
                this.stats.failed++;
            }
        }
        this.sendProgress('Cleanup completed.', progressChannel);
    }

    async cloneRoles(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('👑 Cloning roles...', progressChannel);
        try {
            this.roleMapping.set(sourceGuild.roles.everyone.id, targetGuild.roles.everyone.id);
        } catch (err) {
            this.roleMapping.set(sourceGuild.id, targetGuild.id);
        }
        
        const roles = [...sourceGuild.roles.cache.values()]
            .filter(role => role.name !== '@everyone')
            .sort((a, b) => b.position - a.position);

        const createdRoles = [];

        for (const role of roles) {
            try {
                const newRole = await handleRateLimit(
                    targetGuild.roles.create({
                        name: role.name,
                        color: role.hexColor,
                        permissions: role.permissions,
                        hoist: role.hoist,
                        mentionable: role.mentionable,
                    })
                );
                
                createdRoles.push({ sourceRole: role, newRole: newRole });
                this.roleMapping.set(role.id, newRole.id);
                this.stats.rolesCreated++;
                await delay(200);
            } catch (error) {
                this.sendProgress(`Failed to create role ${role.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }

        this.sendProgress('📐 Setting role positions...', progressChannel);
        for (const { sourceRole, newRole } of createdRoles) {
            try {
                if (newRole.position !== sourceRole.position) {
                    await handleRateLimit(newRole.setPosition(sourceRole.position));
                    await delay(100);
                }
            } catch (error) {
                this.sendProgress(`Failed to set position for role ${sourceRole.name}: ${error.message}`, progressChannel);
            }
        }
    }
    
    async cloneCategories(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('📁 Cloning categories...', progressChannel);
        const categories = [...sourceGuild.channels.cache.values()]
            .filter(ch => ch.type === 'GUILD_CATEGORY')
            .sort((a, b) => a.position - b.position);

        this.categoryMapping = new Map();

        for (const category of categories) {
            try {
                const overwrites = this.mapPermissionOverwrites(category.permissionOverwrites, targetGuild);
                const newCategory = await handleRateLimit(
                    targetGuild.channels.create(category.name, {
                        type: 'GUILD_CATEGORY',
                        permissionOverwrites: overwrites,
                        position: category.position,
                    })
                );
                
                if (newCategory.position !== category.position) {
                    await handleRateLimit(newCategory.setPosition(category.position));
                }
                
                this.categoryMapping.set(category.id, newCategory.id);
                this.stats.categoriesCreated++;
                await delay(200);
            } catch (error) {
                this.sendProgress(`Failed to create category ${category.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }
    }

    async cloneChannels(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('💬 Cloning channels...', progressChannel);
        
        const channels = [...sourceGuild.channels.cache.values()]
            .filter(ch => ch.type === 'GUILD_TEXT' || ch.type === 'GUILD_VOICE')
            .sort((a, b) => a.position - b.position);

        for (const channel of channels) {
            try {
                const parentCategoryId = channel.parentId ? this.categoryMapping.get(channel.parentId) : null;
                const parent = parentCategoryId ? targetGuild.channels.cache.get(parentCategoryId) : null;
                
                const channelOptions = {
                    type: channel.type,
                    parent: parent?.id,
                    permissionOverwrites: this.mapPermissionOverwrites(channel.permissionOverwrites, targetGuild),
                    topic: channel.topic || '',
                    nsfw: channel.nsfw,
                    rateLimitPerUser: channel.rateLimitPerUser,
                    bitrate: channel.bitrate,
                    userLimit: channel.userLimit,
                    position: channel.position,
                };
                const newChannel = await handleRateLimit(
                    targetGuild.channels.create(channel.name, channelOptions)
                );
                
                if (newChannel.position !== channel.position) {
                    await handleRateLimit(newChannel.setPosition(channel.position));
                }
                
                this.stats.channelsCreated++;
                await delay(200);
            } catch (error) {
                this.sendProgress(`Failed to create channel ${channel.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }
    }

    async cloneEmojis(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('😀 Cloning emojis...', progressChannel);
        for (const [, emoji] of sourceGuild.emojis.cache) {
            try {
                const imageData = await downloadImage(emoji.url);
                await targetGuild.emojis.create(imageData, emoji.name);
                this.stats.emojisCreated++;
                await delay(2000);
            } catch (error) {
                this.sendProgress(`Failed to create emoji ${emoji.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }
    }

    async cloneServerInfo(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('🏠 Cloning server info...', progressChannel);
        try {
            await targetGuild.setName(sourceGuild.name);
            if (sourceGuild.iconURL()) {
                const iconData = await downloadImage(sourceGuild.iconURL({ format: 'png', size: 1024 }));
                await targetGuild.setIcon(iconData);
            }
        } catch (error) {
            this.sendProgress(`Failed to update server info: ${error.message}`, progressChannel);
            this.stats.failed++;
        }
    }

    mapPermissionOverwrites(overwrites, targetGuild) {
        if (!overwrites || !overwrites.cache) return [];
        
        return [...overwrites.cache.values()].map(overwrite => {
            let targetId;
            
            if (overwrite.type === 'role') {
                targetId = this.roleMapping.get(overwrite.id);
                if (!targetId) {
                    const sourceRole = this.client.guilds.cache.get(overwrite.id)?.roles.cache.get(overwrite.id);
                    if (sourceRole) {
                        const targetRole = targetGuild.roles.cache.find(r => r.name === sourceRole.name);
                        targetId = targetRole?.id;
                    }
                }
                if (!targetId && overwrite.id === targetGuild.id) {
                    targetId = targetGuild.roles.everyone.id;
                }
            } else {
                targetId = overwrite.id;
            }
            
            if (!targetId) return null;
            
            return {
                id: targetId,
                type: overwrite.type,
                allow: overwrite.allow.bitfield || overwrite.allow.toArray(),
                deny: overwrite.deny.bitfield || overwrite.deny.toArray(),
            };
        }).filter(Boolean);
    }
    
    showStats(progressChannel) {
        const total = this.stats.rolesCreated + this.stats.categoriesCreated + this.stats.channelsCreated + this.stats.emojisCreated;
        const successRate = total > 0 ? Math.round((total / (total + this.stats.failed)) * 100) : 0;
        
        const statsMessage = `
📊 **Cloning Statistics:**
✅ Roles: ${this.stats.rolesCreated}
✅ Categories: ${this.stats.categoriesCreated}
✅ Channels: ${this.stats.channelsCreated}
✅ Emojis: ${this.stats.emojisCreated}
❌ Failed: ${this.stats.failed}
📈 Success Rate: ${successRate}%`;
        
        this.sendProgress(statsMessage, progressChannel);
    }
}

module.exports = ServerCloner;