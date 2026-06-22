// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';

const logger = new Logger('GuildBotCommands');

export interface GuildInstalledBot {
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
	bots: Array<GuildInstalledBot>;
}

export interface GuildBotChannelScope {
	guild_id: string;
	bot_user_id: string;
	application_id: string;
	channel_ids: Array<string>;
	updated_at: string | null;
}

export async function fetchGuildBots(guildId: string): Promise<GuildInstalledBotsResponse> {
	try {
		const response = await http.get<GuildInstalledBotsResponse>(Endpoints.GUILD_BOTS(guildId));
		return response.body;
	} catch (error) {
		logger.error(`Failed to fetch installed bots for guild ${guildId}:`, error);
		throw error;
	}
}

export async function updateGuildBotChannels(
	guildId: string,
	botUserId: string,
	channelIds: Array<string>,
): Promise<GuildBotChannelScope> {
	try {
		const response = await http.put<GuildBotChannelScope>(Endpoints.GUILD_BOT_CHANNELS(guildId, botUserId), {
			body: {channel_ids: channelIds},
		});
		return response.body;
	} catch (error) {
		logger.error(`Failed to update bot ${botUserId} channel scope for guild ${guildId}:`, error);
		throw error;
	}
}
