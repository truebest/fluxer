// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApplicationID} from '../BrandedTypes';
import {fetchOne, upsertOne} from '../database/CassandraQueryExecution';
import type {ManagedBotSpecRow} from '../database/types/OAuth2Types';
import {ManagedBotSpecs} from '../Tables';

const SELECT_MANAGED_BOT_SPEC_CQL = ManagedBotSpecs.selectCql({
	where: ManagedBotSpecs.where.eq('application_id'),
});

export class ManagedBotRepository {
	async get(applicationId: ApplicationID): Promise<ManagedBotSpecRow | null> {
		return fetchOne<ManagedBotSpecRow>(SELECT_MANAGED_BOT_SPEC_CQL, {application_id: applicationId});
	}

	async upsert(row: ManagedBotSpecRow): Promise<ManagedBotSpecRow> {
		await upsertOne(ManagedBotSpecs.upsertAll(row));
		return row;
	}

	async delete(applicationId: ApplicationID): Promise<void> {
		await upsertOne(ManagedBotSpecs.deleteByPk({application_id: applicationId}));
	}
}
