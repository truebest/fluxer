// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {UnknownGuildMemberError} from '@fluxer/errors/src/domains/guild/UnknownGuildMemberError';
import type {ApplicationID} from '../../BrandedTypes';
import {createApplicationID, createChannelID, createGuildID, createUserID} from '../../BrandedTypes';
import type {BotChannelScopeRow} from '../../database/types/OAuth2Types';
import type {GuildMember} from '../../models/GuildMember';
import type {User} from '../../models/User';
import {BotChannelScopeRepository, BotChannelScopeService} from '../BotChannelScopeService';

function snowflake(value: string): bigint {
	return BigInt(value);
}

function member(userId: string, joinedAt = new Date('2026-01-01T00:00:00.000Z')): GuildMember {
	return {
		userId: createUserID(snowflake(userId)),
		joinedAt,
	} as GuildMember;
}

function user(params: {id: string; username: string; isBot: boolean; globalName?: string | null}): User {
	return {
		id: createUserID(snowflake(params.id)),
		username: params.username,
		globalName: params.globalName ?? null,
		avatarHash: null,
		isBot: params.isBot,
	} as User;
}

function scope(params: {
	guildId: string;
	botUserId: string;
	applicationId: string;
	channelIds: Array<string>;
	updatedAt: Date;
}): BotChannelScopeRow {
	return {
		guild_id: createGuildID(snowflake(params.guildId)),
		bot_user_id: createUserID(snowflake(params.botUserId)),
		application_id: createApplicationID(snowflake(params.applicationId)),
		channel_ids: new Set(params.channelIds.map((channelId) => createChannelID(snowflake(channelId)))),
		created_by: createUserID(snowflake('1000')),
		updated_by: createUserID(snowflake('1000')),
		created_at: params.updatedAt,
		updated_at: params.updatedAt,
		version: 1,
	};
}

describe('BotChannelScopeService', () => {
	it('lists installed bots with their saved guild channel scopes', async () => {
		const guildId = createGuildID(snowflake('100'));
		const botUserId = createUserID(snowflake('200'));
		const service = new BotChannelScopeService({
			getScope: async () => null,
			listGuildScopes: async () => [
				scope({
					guildId: '100',
					botUserId: '200',
					applicationId: '200',
					channelIds: ['10', '11'],
					updatedAt: new Date('2026-02-03T04:05:06.000Z'),
				}),
			],
			upsertScope: async () => undefined,
		} as BotChannelScopeRepository);

		const result = await service.listInstalledBots({
			guildId,
			guildRepository: {
				listMembers: async () => [member('200'), member('300'), member('400')],
			} as never,
			userRepository: {
				listUsers: async () => [
					user({id: '300', username: 'not-a-bot', isBot: false}),
					user({id: '400', username: 'missing-app', isBot: true}),
					user({id: '200', username: 'bot-alpha', isBot: true, globalName: 'Bot Alpha'}),
				],
			} as never,
			applicationRepository: {
				getApplication: async (applicationId: ApplicationID) =>
					applicationId === createApplicationID(snowflake('200'))
						? {
								applicationId,
								botUserId,
								name: 'Alpha App',
							}
						: null,
			} as never,
		});

		expect(result).toEqual({
			guild_id: '100',
			bots: [
				{
					bot_user_id: '200',
					application_id: '200',
					application_name: 'Alpha App',
					username: 'bot-alpha',
					global_name: 'Bot Alpha',
					avatar: null,
					joined_at: '2026-01-01T00:00:00.000Z',
					channel_ids: ['10', '11'],
					updated_at: '2026-02-03T04:05:06.000Z',
				},
			],
		});
	});

	it('returns an empty channel list when an installed bot has no saved scope', async () => {
		const guildId = createGuildID(snowflake('100'));
		const service = new BotChannelScopeService({
			getScope: async () => null,
			listGuildScopes: async () => [],
			upsertScope: async () => undefined,
		} as BotChannelScopeRepository);

		const result = await service.listInstalledBots({
			guildId,
			guildRepository: {
				listMembers: async () => [member('200')],
			} as never,
			userRepository: {
				listUsers: async () => [user({id: '200', username: 'bot-alpha', isBot: true})],
			} as never,
			applicationRepository: {
				getApplication: async (applicationId: ApplicationID) => ({
					applicationId,
					botUserId: createUserID(snowflake('200')),
					name: 'Alpha App',
				}),
			} as never,
		});

		expect(result.bots).toHaveLength(1);
		expect(result.bots[0]?.channel_ids).toEqual([]);
		expect(result.bots[0]?.updated_at).toBeNull();
	});

	it('lists compact guild bot channel scopes for gateway snapshots', async () => {
		const guildId = createGuildID(snowflake('100'));
		const service = new BotChannelScopeService({
			getScope: async () => null,
			listGuildScopes: async () => [
				scope({
					guildId: '100',
					botUserId: '300',
					applicationId: '300',
					channelIds: ['12'],
					updatedAt: new Date('2026-02-03T04:05:06.000Z'),
				}),
				scope({
					guildId: '100',
					botUserId: '200',
					applicationId: '200',
					channelIds: ['11', '10'],
					updatedAt: new Date('2026-02-03T04:05:06.000Z'),
				}),
			],
			upsertScope: async () => undefined,
		} as BotChannelScopeRepository);

		await expect(service.listGatewayScopes(guildId)).resolves.toEqual([
			{
				bot_user_id: '200',
				channel_ids: ['10', '11'],
			},
			{
				bot_user_id: '300',
				channel_ids: ['12'],
			},
		]);
	});

	it('allows bot channel access when no scope row exists for legacy consistency', async () => {
		const service = new BotChannelScopeService({
			getScope: async () => null,
			listGuildScopes: async () => [],
			upsertScope: async () => undefined,
		} as BotChannelScopeRepository);

		await expect(
			service.isBotAllowedInChannel({
				guildId: createGuildID(snowflake('100')),
				botUserId: createUserID(snowflake('200')),
				channelId: createChannelID(snowflake('10')),
			}),
		).resolves.toBe(true);
	});

	it('resolves requested scope channel ids before invite mutations', async () => {
		const guildId = createGuildID(snowflake('100'));
		const textChannelId = createChannelID(snowflake('10'));
		const service = new BotChannelScopeService({
			getScope: async () => null,
			listGuildScopes: async () => [],
			upsertScope: async () => undefined,
		} as BotChannelScopeRepository);
		const channelRepository = {
			channelData: {
				listGuildChannels: async () => [
					{id: textChannelId, guildId, type: ChannelTypes.GUILD_TEXT, name: 'general', position: 0},
				],
				listChannels: async () => [
					{id: textChannelId, guildId, type: ChannelTypes.GUILD_TEXT, name: 'general', position: 0},
				],
			},
		} as never;

		await expect(
			service.resolveScopeChannelIds({
				guildId,
				channelIds: null,
				channelRepository,
			}),
		).resolves.toEqual([textChannelId]);
		await expect(
			service.resolveScopeChannelIds({
				guildId,
				channelIds: [textChannelId],
				channelRepository,
			}),
		).resolves.toEqual([textChannelId]);
	});

	it('rejects default scope resolution before invite mutations when a guild has no text channels', async () => {
		const service = new BotChannelScopeService({
			getScope: async () => null,
			listGuildScopes: async () => [],
			upsertScope: async () => undefined,
		} as BotChannelScopeRepository);

		await expect(
			service.resolveScopeChannelIds({
				guildId: createGuildID(snowflake('100')),
				channelIds: null,
				channelRepository: {
					channelData: {
						listGuildChannels: async () => [],
						listChannels: async () => [],
					},
				} as never,
			}),
		).rejects.toBeInstanceOf(InputValidationError);
	});

	it('accepts an installed bot using persisted guild membership and user state', async () => {
		const guildId = createGuildID(snowflake('100'));
		const botUserId = createUserID(snowflake('200'));
		const service = new BotChannelScopeService();

		await expect(
			service.requireInstalledBot({
				guildId,
				botUserId,
				guildRepository: {
					getMember: async () => member('200'),
				} as never,
				userRepository: {
					listUsers: async () => [user({id: '200', username: 'bot-alpha', isBot: true})],
				} as never,
			}),
		).resolves.toBeUndefined();
	});

	it('rejects users that are not installed bots', async () => {
		const guildId = createGuildID(snowflake('100'));
		const botUserId = createUserID(snowflake('200'));
		const service = new BotChannelScopeService();

		await expect(
			service.requireInstalledBot({
				guildId,
				botUserId,
				guildRepository: {
					getMember: async () => member('200'),
				} as never,
				userRepository: {
					listUsers: async () => [user({id: '200', username: 'person', isBot: false})],
				} as never,
			}),
		).rejects.toBeInstanceOf(UnknownGuildMemberError);
	});
});
