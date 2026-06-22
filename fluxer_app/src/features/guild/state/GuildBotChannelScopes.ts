// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayBotChannelScope, GuildReadyData} from '@app/features/gateway/types/GatewayGuildTypes';
import {makeAutoObservable, reaction} from 'mobx';

type BotScopeMap = Map<string, ReadonlySet<string>>;

export class GuildBotChannelScopesStore {
	private scopesByGuildId = new Map<string, BotScopeMap>();
	private globalVersion = 0;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	get version(): number {
		return this.globalVersion;
	}

	handleConnectionOpen(guilds: ReadonlyArray<GuildReadyData>): void {
		this.scopesByGuildId.clear();
		for (const guild of guilds) {
			if (guild.unavailable) continue;
			this.setGuildScopes(guild.id, guild.bot_channel_scopes ?? []);
		}
		this.bumpVersion();
	}

	handleGuildCreate(guild: GuildReadyData): void {
		if (guild.unavailable) return;
		this.setGuildScopes(guild.id, guild.bot_channel_scopes ?? []);
		this.bumpVersion();
	}

	handleGuildDelete(guildId: string): void {
		if (this.scopesByGuildId.delete(guildId)) {
			this.bumpVersion();
		}
	}

	updateScope(guildId: string, scope: GatewayBotChannelScope): void {
		let guildScopes = this.scopesByGuildId.get(guildId);
		if (!guildScopes) {
			guildScopes = new Map();
			this.scopesByGuildId.set(guildId, guildScopes);
		}
		guildScopes.set(scope.bot_user_id, new Set(scope.channel_ids));
		this.bumpVersion();
	}

	isBotAllowedInChannel(guildId: string, botUserId: string, channelId: string): boolean {
		const scope = this.scopesByGuildId.get(guildId)?.get(botUserId);
		if (!scope) return true;
		return scope.has(channelId);
	}

	subscribe(callback: () => void): () => void {
		return reaction(
			() => this.version,
			() => callback(),
			{fireImmediately: true},
		);
	}

	private setGuildScopes(guildId: string, scopes: ReadonlyArray<GatewayBotChannelScope>): void {
		const nextScopes: BotScopeMap = new Map();
		for (const scope of scopes) {
			nextScopes.set(scope.bot_user_id, new Set(scope.channel_ids));
		}
		this.scopesByGuildId.set(guildId, nextScopes);
	}

	private bumpVersion(): void {
		this.globalVersion += 1;
	}
}

export default new GuildBotChannelScopesStore();
