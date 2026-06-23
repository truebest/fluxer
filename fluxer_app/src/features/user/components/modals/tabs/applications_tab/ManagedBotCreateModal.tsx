// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {Endpoints} from '@app/features/app/constants/Endpoints';
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

interface ManagedBotOptionsResponse {
	runtimes: Array<{id: 'openclaw'; name: string; available: boolean}>;
	persona_templates: Array<{
		id: string;
		name: string;
		persona_files: Partial<PersonaFiles>;
	}>;
	providers: Array<{
		id: 'openrouter';
		name: string;
		models: Array<string>;
	}>;
	provisioner_available: boolean;
}

interface ManagedBotCreateResponse {
	application: DeveloperApplication;
}

interface ManagedBotCreateModalProps {
	onCreated: (application: DeveloperApplication) => void | Promise<void>;
}

interface ManagedBotCreateFormValues {
	name: string;
	username: string;
	bio: string;
	personaTemplateId: string;
	provider: 'openrouter';
	model: string;
	AGENTS: string;
	SOUL: string;
	TOOLS: string;
}

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

export const ManagedBotCreateModal: React.FC<ManagedBotCreateModalProps> = observer(({onCreated}) => {
	const {i18n} = useLingui();
	const modelListId = useId();
	const nameInputRef = useRef<HTMLInputElement | null>(null);
	const [options, setOptions] = useState<ManagedBotOptionsResponse | null>(null);
	const [isLoadingOptions, setIsLoadingOptions] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const form = useForm<ManagedBotCreateFormValues>({
		defaultValues: {
			name: '',
			username: '',
			bio: '',
			personaTemplateId: '',
			provider: 'openrouter',
			model: '',
			...emptyPersonaFiles(),
		},
	});
	const watchedModel = useWatch({control: form.control, name: 'model'});
	const modelOptions = useMemo(() => {
		const models = options?.providers.find((provider) => provider.id === 'openrouter')?.models ?? [];
		const query = (watchedModel ?? '').trim().toLowerCase();
		const filtered = query ? models.filter((model) => model.toLowerCase().includes(query)) : models;
		return filtered.slice(0, 10);
	}, [options, watchedModel]);
	const canCreateBot = useMemo(
		() =>
			Boolean(
				options?.provisioner_available &&
					options.runtimes.some((runtime) => runtime.id === 'openclaw' && runtime.available),
			),
		[options],
	);
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
				const firstModel = response.body.providers.find((provider) => provider.id === 'openrouter')?.models[0] ?? '';
				const personaFiles = normalizePersonaFiles(firstTemplate?.persona_files);
				setOptions(response.body);
				form.reset({
					name: '',
					username: '',
					bio: '',
					personaTemplateId: firstTemplate?.id ?? '',
					provider: 'openrouter',
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
	const onSubmit = useCallback(
		async (data: ManagedBotCreateFormValues) => {
			if (!canCreateBot) {
				form.setError('name', {type: 'validate', message: 'Bot runtime provisioning is unavailable.'});
				return;
			}
			const response = await http.post<ManagedBotCreateResponse>(Endpoints.MANAGED_BOTS, {
				body: {
					runtime_type: 'openclaw',
					name: data.name.trim(),
					username: data.username.trim() || undefined,
					bio: data.bio.trim() || null,
					persona_template_id: data.personaTemplateId || null,
					persona_files: {
						AGENTS: data.AGENTS,
						SOUL: data.SOUL,
						TOOLS: data.TOOLS,
					},
					provider: 'openrouter',
					model: data.model.trim(),
				},
			});
			await onCreated(response.body.application);
			form.reset();
			ModalCommands.pop();
		},
		[canCreateBot, form, onCreated],
	);
	const {handleSubmit, isSubmitting} = useFormSubmit({
		form,
		onSubmit,
		defaultErrorField: 'name',
	});
	const templateField = form.register('personaTemplateId', {
		onChange: (event) => {
			const templateId = String(event.target.value);
			const template = options?.persona_templates.find((entry) => entry.id === templateId);
			applyPersonaFiles(template?.persona_files);
		},
	});
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
			data-flx="user.applications-tab.managed-bot-create-modal.modal-root--loaded"
		>
			<Form form={form} onSubmit={handleSubmit} data-flx="user.applications-tab.managed-bot-create-modal.form">
				<Modal.Header title={i18n._(CREATE_BOT_DESCRIPTOR)} />
				<Modal.Content>
					<Modal.ContentLayout>
						<div className={styles.managedBotForm}>
							{!canCreateBot && (
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
							<div className={styles.managedBotTwoColumn}>
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
									label={i18n._(MODEL_DESCRIPTOR)}
									{...form.register('model', {required: true, maxLength: 200})}
									list={modelListId}
									maxLength={200}
									required
									disabled={isSubmitting}
									error={form.formState.errors.model?.message}
								/>
							</div>
							<datalist id={modelListId}>
								{modelOptions.map((model) => (
									<option key={model} value={model} />
								))}
							</datalist>
							<Input
								type="text"
								label={i18n._(BOT_BIO_DESCRIPTOR)}
								{...form.register('bio', {maxLength: 1024})}
								maxLength={1024}
								disabled={isSubmitting}
								error={form.formState.errors.bio?.message}
							/>
							<div className={styles.field}>
								<label className={styles.fieldLabel} htmlFor="managed-bot-persona-template">
									{i18n._(PERSONA_TEMPLATE_DESCRIPTOR)}
								</label>
								<select
									id="managed-bot-persona-template"
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
								<Textarea
									label="AGENTS.md"
									minRows={6}
									maxRows={12}
									maxLength={20000}
									showCharacterCount
									disabled={isSubmitting}
									{...form.register('AGENTS', {maxLength: 20000})}
								/>
								<Textarea
									label="SOUL.md"
									minRows={4}
									maxRows={10}
									maxLength={20000}
									showCharacterCount
									disabled={isSubmitting}
									{...form.register('SOUL', {maxLength: 20000})}
								/>
								<Textarea
									label="TOOLS.md"
									minRows={4}
									maxRows={10}
									maxLength={20000}
									showCharacterCount
									disabled={isSubmitting}
									{...form.register('TOOLS', {maxLength: 20000})}
								/>
							</div>
						</div>
					</Modal.ContentLayout>
				</Modal.Content>
				<Modal.Footer>
					<Button type="button" variant="secondary" onClick={handleCancel} disabled={isSubmitting}>
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
					<Button type="submit" variant="primary" submitting={isSubmitting} disabled={isSubmitting || !canCreateBot}>
						{i18n._(CREATE_DESCRIPTOR)}
					</Button>
				</Modal.Footer>
			</Form>
		</Modal.Root>
	);
});
