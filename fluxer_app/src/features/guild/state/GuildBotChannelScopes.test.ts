// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {GuildBotChannelScopesStore} from './GuildBotChannelScopes';

describe('GuildBotChannelScopesStore', () => {
	it('allows legacy bots without a saved scope row', () => {
		const store = new GuildBotChannelScopesStore();
		store.handleConnectionOpen([]);

		expect(store.isBotAllowedInChannel('guild', 'bot', 'developers')).toBe(true);
	});

	it('allows scoped bots in attached channels', () => {
		const store = new GuildBotChannelScopesStore();
		store.handleConnectionOpen([
			{
				id: 'guild',
				unavailable: false,
				properties: {} as never,
				channels: [],
				emojis: [],
				members: [],
				member_count: 0,
				roles: [],
				joined_at: '2026-06-21T00:00:00.000Z',
				bot_channel_scopes: [{bot_user_id: 'bot', channel_ids: ['developers']}],
			},
		]);

		expect(store.isBotAllowedInChannel('guild', 'bot', 'developers')).toBe(true);
	});

	it('denies scoped bots outside attached channels', () => {
		const store = new GuildBotChannelScopesStore();
		store.handleConnectionOpen([
			{
				id: 'guild',
				unavailable: false,
				properties: {} as never,
				channels: [],
				emojis: [],
				members: [],
				member_count: 0,
				roles: [],
				joined_at: '2026-06-21T00:00:00.000Z',
				bot_channel_scopes: [{bot_user_id: 'bot', channel_ids: ['general']}],
			},
		]);

		expect(store.isBotAllowedInChannel('guild', 'bot', 'developers')).toBe(false);
	});
});
