// SPDX-License-Identifier: AGPL-3.0-or-later

import {channelIdToUserId} from '@app/api/BrandedTypes';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import type {GatewayDispatchEvent} from '@app/api/constants/Gateway';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {Channel} from '@app/api/models/Channel';
import {BotChannelScopeService} from '@app/api/oauth/BotChannelScopeService';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';

interface DispatchChannelEventParams {
	gatewayService: IGatewayService;
	channel: Channel;
	event: GatewayDispatchEvent;
	data: unknown;
}

export async function dispatchChannelEvent({
	gatewayService,
	channel,
	event,
	data,
}: DispatchChannelEventParams): Promise<void> {
	if (channel.type === ChannelTypes.DM_PERSONAL_NOTES) {
		const userId = channelIdToUserId(channel.id);
		if (userId === SYSTEM_USER_ID) {
			return;
		}
		return gatewayService.dispatchPresence({
			userId,
			event,
			data,
		});
	}
	if (channel.guildId) {
		const excludedUserIds =
			channel.type === ChannelTypes.GUILD_TEXT
				? await new BotChannelScopeService().listExcludedBotUserIds({
						guildId: channel.guildId,
						channelId: channel.id,
					})
				: [];
		return gatewayService.dispatchGuild({guildId: channel.guildId, event, data, excludedUserIds});
	}
	await Promise.all(
		Array.from(channel.recipientIds)
			.filter((recipientId) => recipientId !== SYSTEM_USER_ID)
			.map((recipientId) => gatewayService.dispatchPresence({userId: recipientId, event, data})),
	);
}
