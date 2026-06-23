// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApplicationID, UserID} from '../BrandedTypes';

interface ProvisionPayload {
	runtime_type: string;
	application_id: string;
	bot_user_id: string;
	runtime_instance_id?: string;
	bot_token?: string;
	fluxer_base_url: string;
	persona_files: Record<string, string>;
	provider: string;
	model: string;
}

interface DeprovisionPayload {
	runtime_type: string;
	application_id: string;
	runtime_instance_id?: string;
}

export interface ProvisionerResult {
	token_delivery_state: 'accepted' | 'not_delivered';
	provision_status: 'running' | 'failed';
	runtime_instance_id: string | null;
	error?: string | null;
}

export class ManagedBotProvisionerClient {
	private readonly baseUrl = process.env.FLUXER_BOT_PROVISIONER_URL?.replace(/\/+$/u, '') ?? '';
	private readonly authToken = process.env.FLUXER_BOT_PROVISIONER_TOKEN ?? '';

	isAvailable(): boolean {
		return this.baseUrl.length > 0;
	}

	async provision(params: {
		runtimeType: string;
		applicationId: ApplicationID;
		botUserId: UserID;
		runtimeInstanceId?: string | null;
		botToken?: string;
		personaFiles: Record<string, string>;
		provider: string;
		model: string;
	}): Promise<ProvisionerResult> {
		if (!this.isAvailable()) {
			return {
				token_delivery_state: 'not_delivered',
				provision_status: 'failed',
				runtime_instance_id: null,
				error: 'Bot provisioner is not configured',
			};
		}
		const publicBaseUrl =
			process.env.FLUXER_PUBLIC_BASE_URL ??
			(process.env.FLUXER_BASE_DOMAIN
				? `${process.env.FLUXER_PUBLIC_SCHEME ?? 'https'}://${process.env.FLUXER_BASE_DOMAIN}`
				: undefined);
		const payload: ProvisionPayload = {
			runtime_type: params.runtimeType,
			application_id: params.applicationId.toString(),
			bot_user_id: params.botUserId.toString(),
			runtime_instance_id: params.runtimeInstanceId ?? undefined,
			fluxer_base_url: publicBaseUrl ?? process.env.FLUXER_PUBLIC_API_BASE_URL ?? process.env.FLUXER_INTERNAL_API_ENDPOINT ?? '',
			persona_files: params.personaFiles,
			provider: params.provider,
			model: params.model,
		};
		if (params.botToken) {
			payload.bot_token = params.botToken;
		}
		const response = await fetch(`${this.baseUrl}/v1/bots/provision`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(payload),
		});
		const body = await this.readJson(response);
		if (!response.ok) {
			return {
				token_delivery_state: body.token_delivery_state === 'accepted' ? 'accepted' : 'not_delivered',
				provision_status: 'failed',
				runtime_instance_id: null,
				error: typeof body.error === 'string' ? body.error : `Provisioner returned HTTP ${response.status}`,
			};
		}
		return {
			token_delivery_state: body.token_delivery_state === 'accepted' ? 'accepted' : 'not_delivered',
			provision_status: body.provision_status === 'running' ? 'running' : 'failed',
			runtime_instance_id: typeof body.runtime_instance_id === 'string' ? body.runtime_instance_id : null,
			error: typeof body.error === 'string' ? body.error : null,
		};
	}

	async deprovision(params: {
		runtimeType: string;
		applicationId: ApplicationID;
		runtimeInstanceId?: string | null;
	}): Promise<void> {
		if (!this.isAvailable()) {
			return;
		}
		const payload: DeprovisionPayload = {
			runtime_type: params.runtimeType,
			application_id: params.applicationId.toString(),
			runtime_instance_id: params.runtimeInstanceId ?? undefined,
		};
		const response = await fetch(`${this.baseUrl}/v1/bots/deprovision`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(payload),
		});
		if (!response.ok && response.status !== 404) {
			const body = await this.readJson(response);
			throw new Error(typeof body.error === 'string' ? body.error : `Provisioner returned HTTP ${response.status}`);
		}
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {'content-type': 'application/json'};
		if (this.authToken) {
			headers.authorization = `Bearer ${this.authToken}`;
		}
		return headers;
	}

	private async readJson(response: Response): Promise<Record<string, unknown>> {
		try {
			const value = (await response.json()) as unknown;
			return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}
}
