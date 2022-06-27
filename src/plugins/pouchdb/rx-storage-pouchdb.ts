
import type {
    PouchDBInstance,
    PouchSettings,
    RxJsonSchema,
    RxStorageInstanceCreationParams,
    RxStorage,
    MaybeReadonly
} from '../../types';

import {
    adapterObject,
    isMaybeReadonlyArray
} from '../../util';
import {
    addPouchPlugin,
    isLevelDown,
    PouchDB
} from './pouch-db';
import { newRxError } from '../../rx-error';

import { RxStorageInstancePouch } from './rx-storage-instance-pouch';
import {
    getPouchIndexDesignDocNameByIndex,
    PouchStorageInternals
} from './pouchdb-helper';
import PouchDBFind from 'pouchdb-find';
import { RxStoragePouchStatics } from './pouch-statics';
import { getPrimaryFieldOfPrimaryKey } from '../../rx-schema-helper';
import { addCustomEventsPluginToPouch } from './custom-events-plugin';
import { addRxStorageMultiInstanceSupport } from '../../rx-storage-multiinstance';
export class RxStoragePouch implements RxStorage<PouchStorageInternals, PouchSettings> {
    public name: string = 'pouchdb';
    public statics = RxStoragePouchStatics;

    constructor(
        public adapter: any,
        public pouchSettings: PouchSettings = {}
    ) {
        checkPouchAdapter(adapter);
    }

    private async createPouch(
        location: string,
        options: PouchSettings
    ): Promise<PouchDBInstance> {
        const pouchDbParameters = {
            location: location,
            adapter: adapterObject(this.adapter),
            settings: options
        };
        const pouchDBOptions = Object.assign(
            {},
            pouchDbParameters.adapter,
            this.pouchSettings,
            pouchDbParameters.settings
        );
        const pouch = new PouchDB(
            pouchDbParameters.location,
            pouchDBOptions
        ) as PouchDBInstance;

        /**
         * In the past we found some errors where the PouchDB is not directly useable
         * so we we had to call .info() first to ensure it can be used.
         * I commented this out for now to get faster database/collection creation.
         * We might have to add this again if something fails.
         */
        // await pouch.info();

        return pouch;
    }

    public async createStorageInstance<RxDocType>(
        params: RxStorageInstanceCreationParams<RxDocType, PouchSettings>
    ): Promise<RxStorageInstancePouch<RxDocType>> {
        const pouchLocation = getPouchLocation(
            params.databaseName,
            params.collectionName,
            params.schema.version
        );
        const pouch = await this.createPouch(
            pouchLocation,
            params.options
        );
        await createIndexesOnPouch(pouch, params.schema);
        const instance = new RxStorageInstancePouch(
            this,
            params.databaseName,
            params.collectionName,
            params.schema,
            {
                pouch
            },
            params.options
        );

        addRxStorageMultiInstanceSupport(
            params,
            instance
        );

        return instance;
    }
}

/**
 * Checks if all is ok with the given adapter,
 * else throws an error.
 */
export function checkPouchAdapter(adapter: string | any) {
    if (typeof adapter === 'string') {
        if (!(PouchDB as any).adapters || !(PouchDB as any).adapters[adapter]) {
            throw newRxError('DB9', {
                adapter
            });
        }
    } else {
        isLevelDown(adapter);
        if (!(PouchDB as any).adapters || !(PouchDB as any).adapters.leveldb) {
            throw newRxError('DB10', {
                adapter
            });
        }
    }
}

/**
 * Creates the indexes of the schema inside of the pouchdb instance.
 * Will skip indexes that already exist.
 */
export async function createIndexesOnPouch(
    pouch: PouchDBInstance,
    schema: RxJsonSchema<any>
): Promise<void> {
    if (!schema.indexes) {
        return;
    }
    const primaryKey = getPrimaryFieldOfPrimaryKey(schema.primaryKey);
    const before = await pouch.getIndexes();
    const existingIndexes: Set<string> = new Set(
        before.indexes.map(idx => idx.name)
    );

    await Promise.all(
        schema.indexes.map(async (indexMaybeArray) => {
            let indexArray: MaybeReadonly<string[]> = isMaybeReadonlyArray(indexMaybeArray) ? indexMaybeArray : [indexMaybeArray];

            /**
             * replace primary key with _id
             * because that is the enforced primary key on pouchdb.
             */
            indexArray = indexArray.map(key => {
                if (key === primaryKey) {
                    return '_id';
                } else {
                    return key;
                }
            });

            const indexName = getPouchIndexDesignDocNameByIndex(indexArray);
            if (existingIndexes.has(indexName)) {
                // index already exists
                return;
            }

            /**
             * TODO we might have even better performance by doing a pouch.bulkDocs()
             * on index creation
             */
            return pouch.createIndex({
                name: indexName,
                ddoc: indexName,
                index: {
                    fields: indexArray
                }
            });
        })
    );
}

/**
 * returns the pouchdb-database-name
 */
export function getPouchLocation(
    dbName: string,
    collectionName: string,
    schemaVersion: number
): string {
    const prefix = dbName + '-rxdb-' + schemaVersion + '-';
    if (!collectionName.includes('/')) {
        return prefix + collectionName;
    } else {
        // if collectionName is a path, we have to prefix the last part only
        const split = collectionName.split('/');
        const last = split.pop();

        let ret = split.join('/');
        ret += '/' + prefix + last;
        return ret;
    }
}


let addedRxDBPouchPlugins = false;

export function getRxStoragePouch(
    adapter: any,
    pouchSettings?: PouchSettings
): RxStoragePouch {
    if (!addedRxDBPouchPlugins) {
        addedRxDBPouchPlugins = true;
        addPouchPlugin(PouchDBFind);
        addCustomEventsPluginToPouch();
    }

    if (!adapter) {
        throw new Error('adapter missing');
    }
    const storage = new RxStoragePouch(adapter, pouchSettings);
    return storage;
}
