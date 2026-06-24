// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import {
	createBotInviteDestinationKey,
	parseBotInviteDestinationKey,
	useBotInviteDestinations,
} from '@app/features/auth/components/pages/oauth_authorize_page/hooks/useBotGuilds';
import {useFormSubmit} from '@app/features/app/hooks/useFormSubmit';
import type {DeveloperApplication} from '@app/features/devtools/models/DeveloperApplication';
import {CANCEL_DESCRIPTOR, CREATE_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {http} from '@app/features/platform/transport/RestTransport';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Form} from '@app/features/ui/components/form/Form';
import {Input, Textarea} from '@app/features/ui/components/form/FormInput';
import {Spinner} from '@app/features/ui/components/Spinner';
import styles from '@app/features/user/components/modals/tabs/applications_tab/ApplicationsTab.module.css';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {useForm, useWatch} from 'react-hook-form';

type PersonaFileName = 'AGENTS' | 'SOUL' | 'TOOLS';
type PersonaFiles = Record<PersonaFileName, string>;
type ManagedBotCreateStep = 'runtime' | 'profile' | 'persona' | 'provider' | 'review' | 'deploy' | 'community';

interface ManagedBotRuntimeOption {
	id: string;
	name: string;
	available: boolean;
}

interface ManagedBotOptionsResponse {
	runtimes: Array<ManagedBotRuntimeOption>;
	persona_templates: Array<{
		id: string;
		name: string;
		persona_files: Partial<PersonaFiles>;
	}>;
	providers: Array<{
		id: string;
		name: string;
		models: Array<string>;
	}>;
	provisioner_available: boolean;
}

interface ManagedBotCreateResponse {
	application: DeveloperApplication;
	managed_bot: {
		provision_status: 'pending' | 'running' | 'failed';
		provision_error: string | null;
	};
}

interface ManagedBotCreateModalProps {
	onCreated: (application: DeveloperApplication) => void | Promise<void>;
	'data-flx'?: string;
}

interface ManagedBotCreateFormValues {
	runtimeType: string;
	name: string;
	username: string;
	bio: string;
	personaTemplateId: string;
	provider: string;
	model: string;
	AGENTS: string;
	SOUL: string;
	TOOLS: string;
}

const CREATE_STEPS: ReadonlyArray<ManagedBotCreateStep> = [
	'runtime',
	'profile',
	'persona',
	'provider',
	'review',
	'deploy',
	'community',
];
const CONFIG_STEPS: ReadonlyArray<ManagedBotCreateStep> = ['runtime', 'profile', 'persona', 'provider', 'review'];
const PERSONA_FILE_NAMES: ReadonlyArray<PersonaFileName> = ['AGENTS', 'SOUL', 'TOOLS'];
const MODEL_SUGGESTION_LIMIT = 10;

const CREATE_BOT_DESCRIPTOR = msg({
	message: 'Create Bot',
	comment: 'Title and button label for the managed bot creation modal.',
});
const APPLICATION_NAME_DESCRIPTOR = msg({
	message: 'Application name',
	comment: 'Short label in the managed bot creation modal.',
});
const BOT_USERNAME_DESCRIPTOR = msg({
	message: 'Bot username',
	comment: 'Short label in the managed bot creation modal.',
});
const BOT_BIO_DESCRIPTOR = msg({
	message: 'Bot bio',
	comment: 'Short label in the managed bot creation modal.',
});
const RUNTIME_DESCRIPTOR = msg({
	message: 'Runtime',
	comment: 'Short label in the managed bot creation modal.',
});
const PROVIDER_DESCRIPTOR = msg({
	message: 'Provider',
	comment: 'Short label in the managed bot creation modal.',
});
const PERSONA_TEMPLATE_DESCRIPTOR = msg({
	message: 'Persona template',
	comment: 'Short label in the managed bot creation modal.',
});
const MODEL_DESCRIPTOR = msg({
	message: 'Model',
	comment: 'Short label in the managed bot creation modal.',
});

const emptyPersonaFiles = (): PersonaFiles => ({
	AGENTS: '',
	SOUL: '',
	TOOLS: '',
});

const normalizePersonaFiles = (files: Partial<PersonaFiles> | undefined): PersonaFiles => ({
	AGENTS: files?.AGENTS ?? '',
	SOUL: files?.SOUL ?? '',
	TOOLS: files?.TOOLS ?? '',
});

function preferredRuntime(runtimes: Array<ManagedBotRuntimeOption>): string {
	return (
		runtimes.find((runtime) => runtime.id === 'hermes' && runtime.available)?.id ??
		runtimes.find((runtime) => runtime.available)?.id ??
		runtimes[0]?.id ??
		''
	);
}

function stepLabel(step: ManagedBotCreateStep): React.ReactNode {
	if (step === 'runtime') return <Trans>Runtime</Trans>;
	if (step === 'profile') return <Trans>Profile</Trans>;
	if (step === 'persona') return <Trans>Persona</Trans>;
	if (step === 'provider') return <Trans>Model</Trans>;
	if (step === 'review') return <Trans>Review</Trans>;
	if (step === 'deploy') return <Trans>Deploy</Trans>;
	return <Trans>Community</Trans>;
}

function parseCurrentInviteDestinationKey(): string | null {
	if (typeof window === 'undefined') return null;
	const parts = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	if (parts[0] !== 'channels') return null;
	const guildId = parts[1];
	const channelId = parts[2];
	if (!guildId) return null;
	if (guildId === '@me') {
		return channelId ? createBotInviteDestinationKey('group_dm', channelId) : null;
	}
	if (guildId === '@favorites' || guildId === '@discover') return null;
	return createBotInviteDestinationKey('guild', guildId);
}

export const ManagedBotCreateModal: React.FC<ManagedBotCreateModalProps> = observer(
	({onCreated, 'data-flx': dataFlx}) => {
		const {i18n} = useLingui();
		const modelListId = useId();
		const runtimeSelectId = useId();
		const providerSelectId = useId();
		const templateSelectId = useId();
		const communitySelectId = useId();
		const nameInputRef = useRef<HTMLInputElement | null>(null);
		const [options, setOptions] = useState<ManagedBotOptionsResponse | null>(null);
		const [isLoadingOptions, setIsLoadingOptions] = useState(true);
		const [loadError, setLoadError] = useState<string | null>(null);
		const [step, setStep] = useState<ManagedBotCreateStep>('runtime');
		const [createdApplication, setCreatedApplication] = useState<DeveloperApplication | null>(null);
		const [createError, setCreateError] = useState<string | null>(null);
		const [selectedDestinationKey, setSelectedDestinationKey] = useState<string | null>(null);
		const [installError, setInstallError] = useState<string | null>(null);
		const [isInstalling, setIsInstalling] = useState(false);
		const [activePersonaFile, setActivePersonaFile] = useState<PersonaFileName>('AGENTS');
		const preferredDestinationKey = useMemo(() => parseCurrentInviteDestinationKey(), []);
		const destinationInitRef = useRef(false);
		const form = useForm<ManagedBotCreateFormValues>({
			defaultValues: {
				runtimeType: '',
				name: '',
				username: '',
				bio: '',
				personaTemplateId: '',
				provider: 'openrouter',
				model: '',
				...emptyPersonaFiles(),
			},
		});
		const runtimeType = useWatch({control: form.control, name: 'runtimeType'});
		const provider = useWatch({control: form.control, name: 'provider'});
		const watchedModel = useWatch({control: form.control, name: 'model'});
		const watchedName = useWatch({control: form.control, name: 'name'});
		const watchedUsername = useWatch({control: form.control, name: 'username'});
		const watchedBio = useWatch({control: form.control, name: 'bio'});
		const watchedPersonaTemplateId = useWatch({control: form.control, name: 'personaTemplateId'});
		const destinations = useBotInviteDestinations(Boolean(createdApplication), 0n);
		const currentStepIndex = CREATE_STEPS.indexOf(step);
		const progressPercent = ((currentStepIndex + 1) / CREATE_STEPS.length) * 100;
		const createFailedAfterApplicationCreated = Boolean(createdApplication && createError);
		const selectedRuntime = useMemo(
			() => options?.runtimes.find((entry) => entry.id === runtimeType) ?? null,
			[options, runtimeType],
		);
		const selectedProvider = useMemo(
			() => options?.providers.find((entry) => entry.id === provider) ?? options?.providers[0] ?? null,
			[options, provider],
		);
		const selectedTemplate = useMemo(
			() => options?.persona_templates.find((entry) => entry.id === watchedPersonaTemplateId) ?? null,
			[options, watchedPersonaTemplateId],
		);
		const selectedDestination = useMemo(
			() => destinations.options.find((entry) => entry.value === selectedDestinationKey) ?? null,
			[destinations.options, selectedDestinationKey],
		);
		const modelOptions = useMemo(() => {
			const models = selectedProvider?.models ?? [];
			const query = (watchedModel ?? '').trim().toLowerCase();
			const filtered = query ? models.filter((model) => model.toLowerCase().includes(query)) : models;
			return filtered.slice(0, MODEL_SUGGESTION_LIMIT);
		}, [selectedProvider, watchedModel]);
		const canCreateBot = useMemo(
			() =>
				Boolean(
					options?.provisioner_available &&
						options.runtimes.some((runtime) => runtime.id === runtimeType && runtime.available),
				),
			[options, runtimeType],
		);
		const stepTitle = useMemo<React.ReactNode>(() => {
			if (step === 'runtime') return <Trans>Select runtime</Trans>;
			if (step === 'profile') return <Trans>Profile</Trans>;
			if (step === 'persona') return <Trans>Persona</Trans>;
			if (step === 'provider') return <Trans>Configure provider</Trans>;
			if (step === 'review') return <Trans>Review</Trans>;
			if (step === 'deploy') return <Trans>Deploy agent</Trans>;
			return <Trans>Add to community</Trans>;
		}, [i18n, step]);
		const applyPersonaFiles = useCallback(
			(files: Partial<PersonaFiles> | undefined) => {
				const normalized = normalizePersonaFiles(files);
				form.setValue('AGENTS', normalized.AGENTS, {shouldDirty: true});
				form.setValue('SOUL', normalized.SOUL, {shouldDirty: true});
				form.setValue('TOOLS', normalized.TOOLS, {shouldDirty: true});
			},
			[form],
		);
		useEffect(() => {
			const controller = new AbortController();
			setIsLoadingOptions(true);
			setLoadError(null);
			http
				.get<ManagedBotOptionsResponse>(Endpoints.MANAGED_BOT_OPTIONS, {signal: controller.signal})
				.then((response) => {
					const firstTemplate = response.body.persona_templates[0];
					const firstProvider =
						response.body.providers.find((entry) => entry.id === 'openrouter') ?? response.body.providers[0];
					const firstModel = firstProvider?.models[0] ?? '';
					const personaFiles = normalizePersonaFiles(firstTemplate?.persona_files);
					setOptions(response.body);
					form.reset({
						runtimeType: preferredRuntime(response.body.runtimes),
						name: '',
						username: '',
						bio: '',
						personaTemplateId: firstTemplate?.id ?? '',
						provider: firstProvider?.id ?? 'openrouter',
						model: firstModel,
						...personaFiles,
					});
				})
				.catch((err) => {
					if ((err as DOMException).name === 'AbortError') return;
					setLoadError(err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					if (!controller.signal.aborted) {
						setIsLoadingOptions(false);
					}
				});
			return () => controller.abort();
		}, [form]);
		const handleCancel = useCallback(() => {
			form.reset();
			form.clearErrors();
			ModalCommands.pop();
		}, [form]);
		const validateStep = useCallback(
			async (targetStep: ManagedBotCreateStep): Promise<boolean> => {
				if (targetStep === 'runtime') return form.trigger('runtimeType');
				if (targetStep === 'profile') return form.trigger(['name', 'username', 'bio']);
				if (targetStep === 'persona') return form.trigger(['AGENTS', 'SOUL', 'TOOLS']);
				if (targetStep === 'provider') return form.trigger(['provider', 'model']);
				return true;
			},
			[form],
		);
		const handleNext = useCallback(async () => {
			if (!(await validateStep(step))) return;
			setCreateError(null);
			const nextStep = CONFIG_STEPS[CONFIG_STEPS.indexOf(step) + 1];
			if (nextStep) setStep(nextStep);
		}, [step, validateStep]);
		const handleBack = useCallback(() => {
			const previousStep = CREATE_STEPS[currentStepIndex - 1];
			if (previousStep && previousStep !== 'deploy') {
				setStep(previousStep);
				return;
			}
			handleCancel();
		}, [currentStepIndex, handleCancel]);
		const onSubmit = useCallback(
			async (data: ManagedBotCreateFormValues) => {
				if (step !== 'review') return;
				setCreateError(null);
				if (!canCreateBot) {
					form.setError('runtimeType', {type: 'validate', message: 'Bot runtime provisioning is unavailable.'});
					setStep('runtime');
					return;
				}
				setStep('deploy');
				try {
					const response = await http.post<ManagedBotCreateResponse>(Endpoints.MANAGED_BOTS, {
						body: {
							runtime_type: data.runtimeType,
							name: data.name.trim(),
							username: data.username.trim() || undefined,
							bio: data.bio.trim() || null,
							persona_template_id: data.personaTemplateId || null,
							persona_files: {
								AGENTS: data.AGENTS,
								SOUL: data.SOUL,
								TOOLS: data.TOOLS,
							},
							provider: data.provider,
							model: data.model.trim(),
						},
					});
					if (response.body.managed_bot.provision_status !== 'running') {
						setCreatedApplication(response.body.application);
						setCreateError(response.body.managed_bot.provision_error || 'Bot provisioning failed.');
						setStep('review');
						void Promise.resolve(onCreated(response.body.application)).catch(() => undefined);
						return;
					}
					setCreatedApplication(response.body.application);
					setInstallError(null);
					setStep('community');
					void Promise.resolve(onCreated(response.body.application)).catch(() => undefined);
				} catch (err) {
					setStep('review');
					throw err;
				}
			},
			[canCreateBot, form, onCreated, step],
		);
		const {handleSubmit, isSubmitting} = useFormSubmit({
			form,
			onSubmit,
			defaultErrorField: 'name',
		});
		const handleCreate = useCallback(() => {
			void handleSubmit();
		}, [handleSubmit]);
		const handleFormSubmit = useCallback(
			(_values: ManagedBotCreateFormValues, event?: React.BaseSyntheticEvent) => {
				if (step === 'review') {
					void handleSubmit(_values, event);
					return;
				}
				if (CONFIG_STEPS.includes(step)) {
					void handleNext();
				}
			},
			[handleNext, handleSubmit, step],
		);
		useEffect(() => {
			if (!createdApplication) {
				destinationInitRef.current = false;
				setSelectedDestinationKey(null);
				return;
			}
			if (destinationInitRef.current || destinations.status !== 'ready') return;
			if (preferredDestinationKey && destinations.options.some((entry) => entry.value === preferredDestinationKey)) {
				setSelectedDestinationKey(preferredDestinationKey);
				destinationInitRef.current = true;
				return;
			}
			setSelectedDestinationKey(destinations.options[0]?.value ?? null);
			destinationInitRef.current = true;
		}, [createdApplication, destinations.options, destinations.status, preferredDestinationKey]);
		const handleInstallDestination = useCallback(async () => {
			if (!createdApplication || !selectedDestination) return;
			const body: Record<string, string> = {
				client_id: createdApplication.id,
				scope: 'bot',
				permissions: '0',
			};
			if (selectedDestination.kind === 'guild') {
				body.guild_id = selectedDestination.id;
			} else {
				body.channel_id = selectedDestination.id;
			}
			setIsInstalling(true);
			setInstallError(null);
			try {
				await http.post<{redirect_to?: string}>(Endpoints.OAUTH_CONSENT, {body});
				ModalCommands.pop();
			} catch (err) {
				setInstallError(err instanceof Error ? err.message : String(err));
			} finally {
				setIsInstalling(false);
			}
		}, [createdApplication, selectedDestination]);
		const templateField = form.register('personaTemplateId', {
			onChange: (event) => {
				const templateId = String(event.target.value);
				const template = options?.persona_templates.find((entry) => entry.id === templateId);
				applyPersonaFiles(template?.persona_files);
				setActivePersonaFile('AGENTS');
			},
		});
		const runtimeField = form.register('runtimeType', {required: true});
		const providerField = form.register('provider', {required: true});
		const nameField = form.register('name', {required: true, maxLength: 100});
		if (isLoadingOptions) {
			return (
				<Modal.Root size="medium" centered data-flx="user.applications-tab.managed-bot-create-modal.modal-root">
					<Modal.Header title={i18n._(CREATE_BOT_DESCRIPTOR)} />
					<Modal.Content>
						<Modal.ContentLayout>
							<div className={styles.managedBotLoading}>
								<Spinner />
							</div>
						</Modal.ContentLayout>
					</Modal.Content>
				</Modal.Root>
			);
		}
		if (loadError || !options) {
			return (
				<Modal.Root size="medium" centered data-flx="user.applications-tab.managed-bot-create-modal.modal-root--error">
					<Modal.Header title={i18n._(CREATE_BOT_DESCRIPTOR)} />
					<Modal.Content>
						<Modal.ContentLayout>
							<div className={styles.errorCard}>
								<div className={styles.errorHeader}>
									<h3 className={styles.errorTitle}>
										<Trans>Unable to load bot options</Trans>
									</h3>
									<p className={styles.errorSubtitle}>{loadError}</p>
								</div>
							</div>
						</Modal.ContentLayout>
					</Modal.Content>
					<Modal.Footer>
						<Button type="button" variant="secondary" onClick={handleCancel}>
							{i18n._(CANCEL_DESCRIPTOR)}
						</Button>
					</Modal.Footer>
				</Modal.Root>
			);
		}
		return (
			<Modal.Root
				size="large"
				centered
				initialFocusRef={nameInputRef}
				data-flx={dataFlx ?? 'user.applications-tab.managed-bot-create-modal.modal-root--loaded'}
			>
				<Form form={form} onSubmit={handleFormSubmit} data-flx="user.applications-tab.managed-bot-create-modal.form">
					<Modal.Header title={i18n._(CREATE_BOT_DESCRIPTOR)} />
					<Modal.Content>
						<Modal.ContentLayout>
							<div className={styles.managedBotForm}>
								<div className={styles.managedBotStepHeader}>
									<div className={styles.managedBotStepCounter}>
										<Trans>
											Step {currentStepIndex + 1} of {CREATE_STEPS.length}
										</Trans>
										<span aria-hidden="true"> · </span>
										<span>{stepLabel(step)}</span>
									</div>
									<div className={styles.managedBotProgressTrack} aria-hidden="true">
										<span className={styles.managedBotProgressFill} style={{width: `${progressPercent}%`}} />
									</div>
									<h3 className={styles.managedBotStepTitle}>{stepTitle}</h3>
								</div>
								<div className={styles.managedBotWizardLayout}>
									<nav className={styles.managedBotStepNav} aria-label="Create bot progress">
										{CREATE_STEPS.map((entry, index) => (
											<div
												key={entry}
												className={styles.managedBotStepNavItem}
												data-state={
													index < currentStepIndex ? 'complete' : index === currentStepIndex ? 'active' : 'upcoming'
												}
												aria-current={index === currentStepIndex ? 'step' : undefined}
											>
												<span className={styles.managedBotStepMarker} aria-hidden="true">
													{index < currentStepIndex ? '✓' : index + 1}
												</span>
												<span className={styles.managedBotStepNavLabel}>{stepLabel(entry)}</span>
											</div>
										))}
									</nav>
									<div className={styles.managedBotWizardMain}>
										<h3 className={styles.managedBotStepTitle}>{stepTitle}</h3>
										{!canCreateBot && !createdApplication && (
											<div className={styles.errorCard}>
												<div className={styles.errorHeader}>
													<h3 className={styles.errorTitle}>
														<Trans>Bot runtime is unavailable</Trans>
													</h3>
													<p className={styles.errorSubtitle}>
														<Trans>Creation is disabled until the managed bot provisioner is available.</Trans>
													</p>
												</div>
											</div>
										)}
										{createError && (
											<div className={styles.errorCard}>
												<div className={styles.errorHeader}>
													<h3 className={styles.errorTitle}>
														<Trans>Bot provisioning failed</Trans>
													</h3>
													<p className={styles.errorSubtitle}>{createError}</p>
												</div>
											</div>
										)}
										<div className={styles.managedBotStepBody}>
											{step === 'runtime' && (
												<div className={`${styles.field} ${styles.managedBotCompactField}`}>
													<label className={styles.fieldLabel} htmlFor={runtimeSelectId}>
														{i18n._(RUNTIME_DESCRIPTOR)}
													</label>
													<select
														id={runtimeSelectId}
														className={styles.managedBotSelect}
														disabled={isSubmitting}
														{...runtimeField}
													>
														{options.runtimes.map((runtime) => (
															<option key={runtime.id} value={runtime.id} disabled={!runtime.available}>
																{runtime.name}
															</option>
														))}
													</select>
												</div>
											)}
											{step === 'profile' && (
												<>
													<Input
														type="text"
														label={i18n._(APPLICATION_NAME_DESCRIPTOR)}
														{...nameField}
														ref={(el) => {
															nameField.ref(el);
															nameInputRef.current = el;
														}}
														maxLength={100}
														required
														disabled={isSubmitting}
														error={form.formState.errors.name?.message}
													/>
													<Input
														type="text"
														label={i18n._(BOT_USERNAME_DESCRIPTOR)}
														{...form.register('username', {maxLength: 32})}
														maxLength={32}
														disabled={isSubmitting}
														error={form.formState.errors.username?.message}
													/>
													<Input
														type="text"
														label={i18n._(BOT_BIO_DESCRIPTOR)}
														{...form.register('bio', {maxLength: 1024})}
														maxLength={1024}
														disabled={isSubmitting}
														error={form.formState.errors.bio?.message}
													/>
												</>
											)}
											{step === 'persona' && (
												<>
													<div className={styles.field}>
														<label className={styles.fieldLabel} htmlFor={templateSelectId}>
															{i18n._(PERSONA_TEMPLATE_DESCRIPTOR)}
														</label>
														<select
															id={templateSelectId}
															className={styles.managedBotSelect}
															disabled={isSubmitting}
															{...templateField}
														>
															{options.persona_templates.map((template) => (
																<option key={template.id} value={template.id}>
																	{template.name}
																</option>
															))}
														</select>
													</div>
													<div className={styles.managedBotPersonaFiles}>
														<div className={styles.managedBotPersonaFileTabs} role="tablist" aria-label="Persona files">
															{PERSONA_FILE_NAMES.map((fileName) => (
																<button
																	key={fileName}
																	type="button"
																	className={styles.managedBotPersonaFileTab}
																	role="tab"
																	aria-selected={activePersonaFile === fileName}
																	data-active={activePersonaFile === fileName}
																	onClick={() => setActivePersonaFile(fileName)}
																>
																	{fileName}.md
																</button>
															))}
														</div>
														<div className={styles.managedBotPersonaEditor} role="tabpanel">
															<Textarea
																key={activePersonaFile}
																label={`${activePersonaFile}.md`}
																minRows={12}
																maxRows={12}
																maxLength={20000}
																showCharacterCount
																disabled={isSubmitting}
																{...form.register(activePersonaFile, {maxLength: 20000})}
															/>
														</div>
													</div>
												</>
											)}
											{step === 'provider' && (
												<>
													<div className={`${styles.field} ${styles.managedBotCompactField}`}>
														<label className={styles.fieldLabel} htmlFor={providerSelectId}>
															{i18n._(PROVIDER_DESCRIPTOR)}
														</label>
														<select
															id={providerSelectId}
															className={styles.managedBotSelect}
															disabled={isSubmitting}
															{...providerField}
														>
															{options.providers.map((entry) => (
																<option key={entry.id} value={entry.id}>
																	{entry.name}
																</option>
															))}
														</select>
													</div>
													<Input
														type="text"
														label={i18n._(MODEL_DESCRIPTOR)}
														{...form.register('model', {required: true, maxLength: 200})}
														list={modelListId}
														maxLength={200}
														required
														disabled={isSubmitting}
														error={form.formState.errors.model?.message}
													/>
													<datalist id={modelListId}>
														{modelOptions.map((model) => (
															<option key={model} value={model} />
														))}
													</datalist>
												</>
											)}
											{step === 'review' && (
												<div className={styles.managedBotReviewList}>
													<div>
														<span>{i18n._(RUNTIME_DESCRIPTOR)}</span>
														<strong>{selectedRuntime?.name ?? runtimeType}</strong>
													</div>
													<div>
														<span>{i18n._(APPLICATION_NAME_DESCRIPTOR)}</span>
														<strong>{watchedName}</strong>
													</div>
													<div>
														<span>{i18n._(BOT_USERNAME_DESCRIPTOR)}</span>
														<strong>{watchedUsername || '-'}</strong>
													</div>
													<div>
														<span>{i18n._(BOT_BIO_DESCRIPTOR)}</span>
														<strong>{watchedBio || '-'}</strong>
													</div>
													<div>
														<span>{i18n._(PERSONA_TEMPLATE_DESCRIPTOR)}</span>
														<strong>{selectedTemplate?.name ?? '-'}</strong>
													</div>
													<div>
														<span>{i18n._(PROVIDER_DESCRIPTOR)}</span>
														<strong>{selectedProvider?.name ?? provider}</strong>
													</div>
													<div>
														<span>{i18n._(MODEL_DESCRIPTOR)}</span>
														<strong>{watchedModel}</strong>
													</div>
												</div>
											)}
											{step === 'deploy' && (
												<div className={styles.managedBotLoading}>
													<Spinner />
												</div>
											)}
											{step === 'community' && createdApplication && (
												<>
													<div className={styles.managedBotNotice}>
														<div className={styles.errorHeader}>
															<h3 className={styles.errorTitle}>
																<Trans>Bot created</Trans>
															</h3>
															<p className={styles.errorSubtitle}>
																<Trans>Select a community where the bot should be added.</Trans>
															</p>
														</div>
													</div>
													<div className={`${styles.field} ${styles.managedBotCompactField}`}>
														<label className={styles.fieldLabel} htmlFor={communitySelectId}>
															<Trans>Community</Trans>
														</label>
														<select
															id={communitySelectId}
															className={styles.managedBotSelect}
															value={selectedDestinationKey ?? ''}
															onChange={(event) => {
																const value = event.target.value;
																setSelectedDestinationKey(parseBotInviteDestinationKey(value) ? value : null);
																setInstallError(null);
															}}
															disabled={
																destinations.status === 'loading' || destinations.options.length === 0 || isInstalling
															}
														>
															<option value="">
																{destinations.status === 'loading' ? 'Loading communities...' : 'Choose a community'}
															</option>
															{destinations.options.map((destination) => (
																<option key={destination.value} value={destination.value}>
																	{destination.label}
																</option>
															))}
														</select>
													</div>
													{destinations.error && <p className={styles.errorSubtitle}>{destinations.error}</p>}
													{installError && <p className={styles.errorSubtitle}>{installError}</p>}
												</>
											)}
										</div>
									</div>
								</div>
							</div>
						</Modal.ContentLayout>
					</Modal.Content>
					<Modal.Footer>
						{step === 'deploy' ? null : step === 'community' ? (
							<>
								<Button type="button" variant="secondary" onClick={handleCancel} disabled={isInstalling}>
									{i18n._(CANCEL_DESCRIPTOR)}
								</Button>
								<Button
									type="button"
									variant="primary"
									onClick={handleInstallDestination}
									submitting={isInstalling}
									disabled={isInstalling || !selectedDestination}
								>
									<Trans>Add bot</Trans>
								</Button>
							</>
						) : createFailedAfterApplicationCreated ? (
							<Button type="button" variant="secondary" onClick={handleCancel} disabled={isSubmitting}>
								<Trans>Close</Trans>
							</Button>
						) : (
							<>
								<Button
									type="button"
									variant="secondary"
									onClick={step === 'runtime' ? handleCancel : handleBack}
									disabled={isSubmitting}
								>
									{step === 'runtime' ? i18n._(CANCEL_DESCRIPTOR) : <Trans>Back</Trans>}
								</Button>
								{step === 'review' ? (
									<Button
										type="button"
										variant="primary"
										onClick={handleCreate}
										submitting={isSubmitting}
										disabled={isSubmitting || !canCreateBot}
									>
										{i18n._(CREATE_DESCRIPTOR)}
									</Button>
								) : (
									<Button type="button" variant="primary" onClick={handleNext} disabled={isSubmitting || !canCreateBot}>
										<Trans>Next</Trans>
									</Button>
								)}
							</>
						)}
					</Modal.Footer>
				</Form>
			</Modal.Root>
		);
	},
);
