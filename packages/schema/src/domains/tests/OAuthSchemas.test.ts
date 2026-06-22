// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {AuthorizeRequest} from '../oauth/OAuthSchemas';

describe('OAuth schemas', () => {
	test('authorize request flattens repeated comma-separated guild channel IDs', () => {
		const result = AuthorizeRequest.parse({
			response_type: 'code',
			client_id: '1',
			scope: 'bot',
			guild_id: '2',
			guild_channel_ids: ['10', '11,12', '13, 14'],
		});

		expect(result.guild_channel_ids).toEqual([10n, 11n, 12n, 13n, 14n]);
	});
});
