// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {parseAuthorizeQuery} from './OAuthAuthorizePageShared';

describe('parseAuthorizeQuery', () => {
	it('preserves repeated and comma-separated guild channel ids', () => {
		const params = parseAuthorizeQuery(
			'?client_id=1&scope=bot&guild_id=2&guild_channel_ids=10&guild_channel_ids=11,12&guild_channel_ids=10',
		);

		expect(params?.guildChannelIds).toEqual(['10', '11', '12']);
	});
});
