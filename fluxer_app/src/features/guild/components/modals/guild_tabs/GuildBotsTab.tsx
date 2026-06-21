// SPDX-License-Identifier: AGPL-3.0-or-later

import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import Channels from '@app/features/channel/state/Channels';
import * as ChannelUtils from '@app/features/channel/utils/ChannelUtils';
import {UNKNOWN_CHANNEL_DESCRIPTOR} from '@app/features/channel/utils/ChannelMessageDescriptors';
import * as GuildBotCommands from '@app/features/guild/commands/GuildBotCommands';
import type {GuildInstalledBot} from '@app/features/guild/commands/GuildBotCommands';
import styles from '@app/features/guild/components/modals/guild_tabs/GuildBotsTab.module.css';
import {TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import Permission from '@app/features/permissions/state/Permission';
import {formatPermissionLabel} from '@app/features/permissions/utils/PermissionUtils';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import * as UnsavedChangesCommands from '@app/features/ui/commands/UnsavedChangesCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {RobotIcon, WarningCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useMemo, useState} from 'react';

const GUILD_BOTS_TAB_ID = 'bots';

const FAILED_TO_LOAD_BOTS_DESCRIPTOR = msg({
	message: 'Failed to load bots',
	comment: 'Error message in the guild bots settings tab.',
});
const THERE_WAS_AN_ERROR_LOADING_BOTS_DESCRIPTOR = msg({
	message: 'There was an error loading the bots. Try again.',
	comment: 'Error message in the guild bots settings tab.',
});
const BOT_CHANNELS_UPDATED_DESCRIPTOR = msg({
	message: 'Bot channel access updated',
	comment: 'Success toast after saving bot channel bindings.',
});
const BOT_CHANNELS_UPDATE_FAILED_DESCRIPTOR = msg({
	message: "Couldn't update bot channel access",
	comment: 'Error toast after saving bot channel bindings fails.',
});

type FetchStatus = 'idle' | 'pending' | 'success' | 'error';

function normalizeIds(ids: ReadonlyArray<string>): Array<string> {
	const seen = new Set<string>();
	for (const id of ids) {
		seen.add(id);
	}
	return Array.from(seen).sort((left, right) => {
		const leftBigInt = BigInt(left);
		const rightBigInt = BigInt(right);
		if (leftBigInt === rightBigInt) return 0;
		return leftBigInt < rightBigInt ? -1 : 1;
	});
}

function equalIds(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
	const normalizedLeft = normalizeIds(left);
	const normalizedRight = normalizeIds(right);
	if (normalizedLeft.length !== normalizedRight.length) return false;
	return normalizedLeft.every((id, index) => id === normalizedRight[index]);
}

function buildDraft(bots: ReadonlyArray<GuildInstalledBot>): Record<string, Array<string>> {
	const draft: Record<string, Array<string>> = {};
	for (const bot of bots) {
		draft[bot.bot_user_id] = normalizeIds(bot.channel_ids);
	}
	return draft;
}

function getBotDisplayName(bot: GuildInstalledBot): string {
	return bot.global_name || bot.username || bot.application_name;
}

const GuildBotsTab: React.FC<{guildId: string}> = observer(({guildId}) => {
	const {i18n} = useLingui();
	const canManageGuild = Permission.can(Permissions.MANAGE_GUILD, {guildId});
	const manageGuildPermissionLabel = formatPermissionLabel(i18n, Permissions.MANAGE_GUILD);
	const [fetchStatus, setFetchStatus] = useState<FetchStatus>('idle');
	const [bots, setBots] = useState<Array<GuildInstalledBot>>([]);
	const [draftByBotId, setDraftByBotId] = useState<Record<string, Array<string>>>({});
	const [isSubmitting, setIsSubmitting] = useState(false);
	const guildChannels = Channels.getGuildChannels(guildId);
	const textChannels = useMemo(
		() =>
			guildChannels
				.filter((channel) => channel.type === ChannelTypes.GUILD_TEXT)
				.slice()
				.sort(ChannelUtils.compareChannels),
		[guildChannels],
	);
	const channelNameById = useMemo(() => {
		const names = new Map<string, string>();
		for (const channel of textChannels) {
			names.set(channel.id, channel.name ?? i18n._(UNKNOWN_CHANNEL_DESCRIPTOR));
		}
		return names;
	}, [textChannels, i18n.locale]);
	const hasUnsavedChanges = useMemo(() => {
		return bots.some((bot) => !equalIds(bot.channel_ids, draftByBotId[bot.bot_user_id] ?? []));
	}, [bots, draftByBotId]);
	const loadBots = useCallback(async () => {
		if (!canManageGuild) {
			return;
		}
		setFetchStatus('pending');
		try {
			const result = await GuildBotCommands.fetchGuildBots(guildId);
			setBots(result.bots);
			setDraftByBotId(buildDraft(result.bots));
			setFetchStatus('success');
		} catch (_error) {
			setFetchStatus('error');
		}
	}, [canManageGuild, guildId]);
	useEffect(() => {
		void loadBots();
	}, [loadBots]);
	useEffect(() => {
		UnsavedChangesCommands.setUnsavedChanges(GUILD_BOTS_TAB_ID, hasUnsavedChanges);
	}, [hasUnsavedChanges]);
	const handleReset = useCallback(() => {
		setDraftByBotId(buildDraft(bots));
	}, [bots]);
	const handleSave = useCallback(async () => {
		if (!canManageGuild || !hasUnsavedChanges || isSubmitting) {
			return;
		}
		setIsSubmitting(true);
		try {
			const changedBots = bots.filter((bot) => !equalIds(bot.channel_ids, draftByBotId[bot.bot_user_id] ?? []));
			const updates = await Promise.all(
				changedBots.map((bot) =>
					GuildBotCommands.updateGuildBotChannels(
						guildId,
						bot.bot_user_id,
						normalizeIds(draftByBotId[bot.bot_user_id] ?? []),
					),
				),
			);
			const updatesByBotId = new Map(updates.map((update) => [update.bot_user_id, update]));
			const nextBots = bots.map((bot) => {
				const update = updatesByBotId.get(bot.bot_user_id);
				if (!update) return bot;
				return {
					...bot,
					channel_ids: normalizeIds(update.channel_ids),
					updated_at: update.updated_at,
				};
			});
			setBots(nextBots);
			setDraftByBotId(buildDraft(nextBots));
			ToastCommands.success(i18n._(BOT_CHANNELS_UPDATED_DESCRIPTOR));
		} catch (_error) {
			ToastCommands.error(i18n._(BOT_CHANNELS_UPDATE_FAILED_DESCRIPTOR));
		} finally {
			setIsSubmitting(false);
		}
	}, [bots, canManageGuild, draftByBotId, guildId, hasUnsavedChanges, i18n, isSubmitting]);
	useEffect(() => {
		UnsavedChangesCommands.setTabData(GUILD_BOTS_TAB_ID, {
			onReset: handleReset,
			onSave: handleSave,
			isSubmitting,
		});
	}, [handleReset, handleSave, isSubmitting]);
	useEffect(() => {
		return () => {
			UnsavedChangesCommands.clearUnsavedChanges(GUILD_BOTS_TAB_ID);
		};
	}, []);
	const toggleChannel = useCallback((botUserId: string, channelId: string, checked: boolean) => {
		setDraftByBotId((prev) => {
			const current = new Set(prev[botUserId] ?? []);
			if (checked) {
				current.add(channelId);
			} else {
				current.delete(channelId);
			}
			return {...prev, [botUserId]: normalizeIds(Array.from(current))};
		});
	}, []);
	return (
		<div className={styles.container} data-flx="guild.guild-tabs.guild-bots-tab.container">
			<div className={styles.header} data-flx="guild.guild-tabs.guild-bots-tab.header">
				<h2 className={styles.title} data-flx="guild.guild-tabs.guild-bots-tab.title">
					<Trans>Bots</Trans>
				</h2>
				<p className={styles.subtitle} data-flx="guild.guild-tabs.guild-bots-tab.subtitle">
					<Trans>Choose which text channels each installed bot can read and send messages in.</Trans>
				</p>
			</div>
			{!canManageGuild && (
				<div className={styles.notice} data-flx="guild.guild-tabs.guild-bots-tab.notice">
					<Trans>
						You need the "{manageGuildPermissionLabel}" permission to view and edit bots for this community.
					</Trans>
				</div>
			)}
			{canManageGuild && fetchStatus === 'pending' && (
				<div className={styles.spinnerContainer} data-flx="guild.guild-tabs.guild-bots-tab.spinner-container">
					<Spinner data-flx="guild.guild-tabs.guild-bots-tab.spinner" />
				</div>
			)}
			{canManageGuild && fetchStatus === 'error' && (
				<StatusSlate
					Icon={WarningCircleIcon}
					title={i18n._(FAILED_TO_LOAD_BOTS_DESCRIPTOR)}
					description={i18n._(THERE_WAS_AN_ERROR_LOADING_BOTS_DESCRIPTOR)}
					actions={[
						{
							text: i18n._(TRY_AGAIN_DESCRIPTOR),
							onClick: () => void loadBots(),
							variant: 'primary',
						},
					]}
					fullHeight={true}
					data-flx="guild.guild-tabs.guild-bots-tab.status-slate"
				/>
			)}
			{canManageGuild && fetchStatus === 'success' && textChannels.length === 0 && (
				<StatusSlate
					Icon={WarningCircleIcon}
					title={<Trans>No text channels</Trans>}
					description={<Trans>Create a text channel before attaching bots to this community.</Trans>}
					fullHeight={true}
					data-flx="guild.guild-tabs.guild-bots-tab.status-slate--2"
				/>
			)}
			{canManageGuild && fetchStatus === 'success' && textChannels.length > 0 && bots.length === 0 && (
				<StatusSlate
					Icon={RobotIcon}
					title={<Trans>No bots installed</Trans>}
					description={<Trans>Installed bots will appear here after they are added to this community.</Trans>}
					fullHeight={true}
					data-flx="guild.guild-tabs.guild-bots-tab.status-slate--3"
				/>
			)}
			{canManageGuild && fetchStatus === 'success' && textChannels.length > 0 && bots.length > 0 && (
				<div className={styles.botList} data-flx="guild.guild-tabs.guild-bots-tab.bot-list">
					{bots.map((bot) => {
						const selectedIds = draftByBotId[bot.bot_user_id] ?? [];
						const selectedCount = selectedIds.filter((id) => channelNameById.has(id)).length;
						return (
							<section
								key={bot.bot_user_id}
								className={styles.botPanel}
								data-flx="guild.guild-tabs.guild-bots-tab.bot-panel"
							>
								<div className={styles.botHeader} data-flx="guild.guild-tabs.guild-bots-tab.bot-header">
									<div className={styles.botIdentity} data-flx="guild.guild-tabs.guild-bots-tab.bot-identity">
										<div className={styles.botIcon} aria-hidden={true} data-flx="guild.guild-tabs.guild-bots-tab.bot-icon">
											<RobotIcon size={20} weight="bold" data-flx="guild.guild-tabs.guild-bots-tab.robot-icon" />
										</div>
										<div className={styles.botText} data-flx="guild.guild-tabs.guild-bots-tab.bot-text">
											<h3 className={styles.botName} data-flx="guild.guild-tabs.guild-bots-tab.bot-name">
												{getBotDisplayName(bot)}
											</h3>
											<p className={styles.botMeta} data-flx="guild.guild-tabs.guild-bots-tab.bot-meta">
												{bot.application_name} - {bot.application_id}
											</p>
										</div>
									</div>
									<div className={styles.botCount} data-flx="guild.guild-tabs.guild-bots-tab.bot-count">
										{selectedCount === 0 ? (
											<Trans>No channels selected</Trans>
										) : selectedCount === 1 ? (
											<Trans>1 channel</Trans>
										) : (
											<Trans>{selectedCount} channels</Trans>
										)}
									</div>
								</div>
								<div className={styles.channelGrid} data-flx="guild.guild-tabs.guild-bots-tab.channel-grid">
									{textChannels.map((channel) => {
										const checked = selectedIds.includes(channel.id);
										const channelName = channel.name ?? i18n._(UNKNOWN_CHANNEL_DESCRIPTOR);
										return (
											<Checkbox
												key={channel.id}
												checked={checked}
												disabled={isSubmitting}
												onChange={(nextChecked) => toggleChannel(bot.bot_user_id, channel.id, nextChecked)}
												size="small"
												className={styles.channelCheckbox}
												data-flx="guild.guild-tabs.guild-bots-tab.channel-checkbox"
											>
												<span className={styles.channelLabel} data-flx="guild.guild-tabs.guild-bots-tab.channel-label">
													<span
														className={styles.channelHash}
														aria-hidden={true}
														data-flx="guild.guild-tabs.guild-bots-tab.channel-hash"
													>
														#
													</span>
													<span className={styles.channelName} data-flx="guild.guild-tabs.guild-bots-tab.channel-name">
														{channelName}
													</span>
												</span>
											</Checkbox>
										);
									})}
								</div>
							</section>
						);
					})}
				</div>
			)}
		</div>
	);
});

export default GuildBotsTab;
