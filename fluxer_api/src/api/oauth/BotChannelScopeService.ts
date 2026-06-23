// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {UnknownGuildMemberError} from '@fluxer/errors/src/domains/guild/UnknownGuildMemberError';
import type {ApplicationID, ChannelID, GuildID, UserID} from '../BrandedTypes';
import type {IChannelRepositoryAggregate} from '../channel/repositories/IChannelRepositoryAggregate';
import {fetchMany, fetchOne, upsertOne} from '../database/CassandraQueryExecution';
import type {BotChannelScopeRow} from '../database/types/OAuth2Types';
import type {IGatewayService} from '../infrastructure/IGatewayService';
import type {Channel} from '../models/Channel';
import type {User} from '../models/User';
import {BotChannelScopes} from '../Tables';
import type {IGuildRepositoryAggregate} from '../guild/repositories/IGuildRepositoryAggregate';
import type {IUserRepository} from '../user/IUserRepository';
import type {IApplicationRepository} from './repositories/IApplicationRepository';

const SELECT_SCOPE = BotChannelScopes.select({
	where: [BotChannelScopes.where.eq('guild_id'), BotChannelScopes.where.eq('bot_user_id')],
	limit: 1,
});
const SELECT_GUILD_SCOPES = BotChannelScopes.select({
	where: BotChannelScopes.where.eq('guild_id'),
});

export interface BotChannelScopeResponse {
	guild_id: string;
	bot_user_id: string;
	application_id: string;
	channel_ids: Array<string>;
	updated_at: string | null;
}

export interface GuildInstalledBotResponse {
	bot_user_id: string;
	application_id: string;
	application_name: string;
	username: string;
	global_name: string | null;
	avatar: string | null;
	joined_at: string;
	channel_ids: Array<string>;
	updated_at: string | null;
}

export interface GuildInstalledBotsResponse {
	guild_id: string;
	bots: Array<GuildInstalledBotResponse>;
}

export interface BotChannelScopeGatewayResponse {
	bot_user_id: string;
	channel_ids: Array<string>;
}

export class BotChannelScopeRepository {
	async getScope(guildId: GuildID, botUserId: UserID): Promise<BotChannelScopeRow | null> {
		return await fetchOne<BotChannelScopeRow>(
			SELECT_SCOPE.bind({
				guild_id: guildId,
				bot_user_id: botUserId,
			}),
		);
	}

	async listGuildScopes(guildId: GuildID): Promise<Array<BotChannelScopeRow>> {
		return await fetchMany<BotChannelScopeRow>(
			SELECT_GUILD_SCOPES.bind({
				guild_id: guildId,
			}),
		);
	}

	async upsertScope(row: BotChannelScopeRow): Promise<void> {
		await upsertOne(BotChannelScopes.upsertAll(row));
	}
}

export class BotChannelScopeService {
	constructor(private readonly repository = new BotChannelScopeRepository()) {}

	mapScope(row: BotChannelScopeRow): BotChannelScopeResponse {
		return {
			guild_id: row.guild_id.toString(),
			bot_user_id: row.bot_user_id.toString(),
			application_id: row.application_id.toString(),
			channel_ids: channelIdsToSortedStrings(this.channelSet(row.channel_ids)),
			updated_at: row.updated_at.toISOString(),
		};
	}

	async requireManageGuild(gatewayService: IGatewayService, guildId: GuildID, userId: UserID): Promise<void> {
		const permissions = await gatewayService.getUserPermissions({guildId, userId});
		if ((permissions & Permissions.MANAGE_GUILD) === 0n) {
			throw new MissingPermissionsError();
		}
	}

	async requireInstalledBot(params: {
		guildRepository: IGuildRepositoryAggregate;
		userRepository: IUserRepository;
		guildId: GuildID;
		botUserId: UserID;
	}): Promise<void> {
		const [member, users] = await Promise.all([
			params.guildRepository.getMember(params.guildId, params.botUserId),
			params.userRepository.listUsers([params.botUserId]),
		]);
		const user = users.find((candidate) => candidate.id === params.botUserId);
		if (!member || user?.isBot !== true) {
			throw new UnknownGuildMemberError();
		}
	}

	async requireBotApplication(
		applicationRepository: IApplicationRepository,
		botUserId: UserID,
	): Promise<ApplicationID> {
		const application = await applicationRepository.getApplicationByBotUserId(botUserId);
		if (!application) {
			throw InputValidationError.create('user_id', 'Unknown bot application');
		}
		return application.applicationId;
	}

	async getScope(guildId: GuildID, botUserId: UserID): Promise<BotChannelScopeResponse | null> {
		const row = await this.repository.getScope(guildId, botUserId);
		return row ? this.mapScope(row) : null;
	}

	async listInstalledBots(params: {
		guildId: GuildID;
		guildRepository: IGuildRepositoryAggregate;
		userRepository: IUserRepository;
		applicationRepository: IApplicationRepository;
	}): Promise<GuildInstalledBotsResponse> {
		const members = await params.guildRepository.listMembers(params.guildId);
		if (members.length === 0) {
			return {guild_id: params.guildId.toString(), bots: []};
		}
		const membersByUserId = new Map(members.map((member) => [member.userId.toString(), member]));
		const users = await params.userRepository.listUsers(members.map((member) => member.userId));
		const botUsers = users.filter((user) => user.isBot && membersByUserId.has(user.id.toString()));
		if (botUsers.length === 0) {
			return {guild_id: params.guildId.toString(), bots: []};
		}
		const scopeRows = await this.repository.listGuildScopes(params.guildId);
		const scopesByBotUserId = new Map(scopeRows.map((row) => [row.bot_user_id.toString(), row]));
		const entries = await Promise.all(
			botUsers.map(async (user) => {
				const application = await params.applicationRepository.getApplicationByBotUserId(user.id);
				if (!application) {
					return null;
				}
				const member = membersByUserId.get(user.id.toString());
				if (!member) {
					return null;
				}
				const scope = scopesByBotUserId.get(user.id.toString());
				return this.mapInstalledBot({
					user,
					applicationName: application.name,
					applicationId: application.applicationId,
					joinedAt: member.joinedAt,
					scope,
				});
			}),
		);
		const bots = entries
			.filter((entry): entry is GuildInstalledBotResponse => entry !== null)
			.sort(compareInstalledBots);
		return {guild_id: params.guildId.toString(), bots};
	}

	async setScope(params: {
		guildId: GuildID;
		botUserId: UserID;
		applicationId: ApplicationID;
		channelIds: Array<ChannelID>;
		updatedBy: UserID;
		channelRepository: IChannelRepositoryAggregate;
	}): Promise<BotChannelScopeResponse> {
		const existing = await this.repository.getScope(params.guildId, params.botUserId);
		const channelIds = await this.validateTextChannelIds({
			guildId: params.guildId,
			channelIds: params.channelIds,
			channelRepository: params.channelRepository,
		});
		const now = new Date();
		const row: BotChannelScopeRow = {
			guild_id: params.guildId,
			bot_user_id: params.botUserId,
			application_id: params.applicationId,
			channel_ids: new Set(channelIds),
			created_by: existing?.created_by ?? params.updatedBy,
			updated_by: params.updatedBy,
			created_at: existing?.created_at ?? now,
			updated_at: now,
			version: (existing?.version ?? 0) + 1,
		};
		await this.repository.upsertScope(row);
		return this.mapScope(row);
	}

	async resolveScopeChannelIds(params: {
		guildId: GuildID;
		channelIds: Array<ChannelID> | null;
		channelRepository: IChannelRepositoryAggregate;
	}): Promise<Array<ChannelID>> {
		if (params.channelIds === null) {
			return await this.resolveDefaultTextChannelIds(params.guildId, params.channelRepository);
		}
		return await this.validateTextChannelIds({
			guildId: params.guildId,
			channelIds: params.channelIds,
			channelRepository: params.channelRepository,
		});
	}

	async setDefaultScope(params: {
		guildId: GuildID;
		botUserId: UserID;
		applicationId: ApplicationID;
		updatedBy: UserID;
		channelRepository: IChannelRepositoryAggregate;
	}): Promise<BotChannelScopeResponse> {
		const channelIds = await this.resolveDefaultTextChannelIds(params.guildId, params.channelRepository);
		return await this.setScope({...params, channelIds});
	}

	async resolveDefaultTextChannelIds(
		guildId: GuildID,
		channelRepository: IChannelRepositoryAggregate,
	): Promise<Array<ChannelID>> {
		const textChannels = (await channelRepository.channelData.listGuildChannels(guildId))
			.filter((channel) => channel.type === ChannelTypes.GUILD_TEXT)
			.sort(compareChannelsForDefault);
		if (textChannels.length === 0) {
			throw InputValidationError.create('guild_id', 'Guild has no text channels');
		}
		const general = textChannels.find((channel) => channel.name?.toLowerCase() === 'general');
		return [general?.id ?? textChannels[0]!.id];
	}

	async isBotAllowedInChannel(params: {
		guildId: GuildID;
		botUserId: UserID;
		channelId: ChannelID;
	}): Promise<boolean> {
		const row = await this.repository.getScope(params.guildId, params.botUserId);
		if (!row) {
			return true;
		}
		return this.channelSet(row.channel_ids).has(params.channelId);
	}

	async listExcludedBotUserIds(params: {guildId: GuildID; channelId: ChannelID}): Promise<Array<UserID>> {
		const rows = await this.repository.listGuildScopes(params.guildId);
		return rows
			.filter((row) => !this.channelSet(row.channel_ids).has(params.channelId))
			.map((row) => row.bot_user_id);
	}

	async listGatewayScopes(guildId: GuildID): Promise<Array<BotChannelScopeGatewayResponse>> {
		const rows = await this.repository.listGuildScopes(guildId);
		return rows
			.map((row) => ({
				bot_user_id: row.bot_user_id.toString(),
				channel_ids: channelIdsToSortedStrings(this.channelSet(row.channel_ids)),
			}))
			.sort(compareGatewayScopeRows);
	}

	private async validateTextChannelIds(params: {
		guildId: GuildID;
		channelIds: Array<ChannelID>;
		channelRepository: IChannelRepositoryAggregate;
	}): Promise<Array<ChannelID>> {
		const deduped = dedupeChannelIds(params.channelIds);
		if (deduped.length === 0) {
			return [];
		}
		const channels = await params.channelRepository.channelData.listChannels(deduped);
		const byId = new Map(channels.map((channel) => [channel.id.toString(), channel]));
		for (const channelId of deduped) {
			const channel = byId.get(channelId.toString());
			if (!this.isValidScopedChannel(channel, params.guildId)) {
				throw InputValidationError.create('channel_ids', 'Expected guild text channel ids');
			}
		}
		return deduped;
	}

	private isValidScopedChannel(channel: Channel | undefined, guildId: GuildID): channel is Channel {
		return channel?.guildId === guildId && channel.type === ChannelTypes.GUILD_TEXT;
	}

	private mapInstalledBot(params: {
		user: User;
		applicationName: string;
		applicationId: ApplicationID;
		joinedAt: Date;
		scope?: BotChannelScopeRow;
	}): GuildInstalledBotResponse {
		return {
			bot_user_id: params.user.id.toString(),
			application_id: params.applicationId.toString(),
			application_name: params.applicationName,
			username: params.user.username,
			global_name: params.user.globalName,
			avatar: params.user.avatarHash,
			joined_at: params.joinedAt.toISOString(),
			channel_ids: params.scope ? channelIdsToSortedStrings(this.channelSet(params.scope.channel_ids)) : [],
			updated_at: params.scope?.updated_at.toISOString() ?? null,
		};
	}

	private channelSet(value: Set<ChannelID> | Array<ChannelID | bigint | string> | null | undefined): Set<ChannelID> {
		if (!value) {
			return new Set();
		}
		if (value instanceof Set) {
			return value as Set<ChannelID>;
		}
		return new Set(value.map((id) => BigInt(id.toString()) as ChannelID));
	}
}

function dedupeChannelIds(channelIds: Array<ChannelID>): Array<ChannelID> {
	const seen = new Set<string>();
	const result: Array<ChannelID> = [];
	for (const channelId of channelIds) {
		const key = channelId.toString();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(channelId);
	}
	return result;
}

function compareChannelsForDefault(left: Channel, right: Channel): number {
	if (left.position !== right.position) {
		return left.position - right.position;
	}
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareInstalledBots(left: GuildInstalledBotResponse, right: GuildInstalledBotResponse): number {
	const leftName = left.global_name || left.username || left.application_name;
	const rightName = right.global_name || right.username || right.application_name;
	const nameComparison = leftName.localeCompare(rightName, undefined, {numeric: true, sensitivity: 'base'});
	if (nameComparison !== 0) {
		return nameComparison;
	}
	return BigInt(left.bot_user_id) < BigInt(right.bot_user_id) ? -1 : 1;
}

function channelIdsToSortedStrings(channelIds: Set<ChannelID>): Array<string> {
	return Array.from(channelIds).sort(compareChannelIds).map((id) => id.toString());
}

function compareChannelIds(left: ChannelID, right: ChannelID): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareGatewayScopeRows(left: BotChannelScopeGatewayResponse, right: BotChannelScopeGatewayResponse): number {
	const leftId = BigInt(left.bot_user_id);
	const rightId = BigInt(right.bot_user_id);
	return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
