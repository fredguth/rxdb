import { filter } from 'rxjs/operators';
import { DocCache } from '../../doc-cache';
import { newRxError } from '../../rx-error';
import { fillWithDefaultSettings } from '../../rx-schema-helper';
import {
    getWrappedStorageInstance,
    storageChangeEventToRxChangeEvent
} from '../../rx-storage-helper';
import type {
    LocalDocumentParent,
    LocalDocumentState,
    RxChangeEvent,
    RxChangeEventBulk,
    RxDatabase,
    RxDocumentData,
    RxJsonSchema,
    RxLocalDocument,
    RxLocalDocumentData,
    RxStorage
} from '../../types';
import { randomCouchString } from '../../util';

const LOCAL_DOC_STATE_BY_PARENT: WeakMap<LocalDocumentParent, Promise<LocalDocumentState>> = new WeakMap();


export function createLocalDocStateByParent(parent: LocalDocumentParent): void {
    const database: RxDatabase = parent.database ? parent.database : parent as any;
    const collectionName = parent.database ? parent.name : '';
    const statePromise = (async () => {
        let storageInstance = await createLocalDocumentStorageInstance(
            database.token,
            database.storage,
            database.name,
            collectionName,
            database.instanceCreationOptions,
            database.multiInstance
        );
        storageInstance = getWrappedStorageInstance(
            database,
            storageInstance,
            RX_LOCAL_DOCUMENT_SCHEMA
        );
        const docCache = new DocCache<RxLocalDocument<any, any>>();

        /**
         * Update cached local documents on events.
         */
        const sub = parent.$
            .pipe(
                filter(cE => (cE as RxChangeEvent<any>).isLocal)
            )
            .subscribe((cE: RxChangeEvent<any>) => {
                const doc = docCache.get(cE.documentId);
                if (doc) {
                    doc._handleChangeEvent(cE);
                }
            });
        parent._subs.push(sub);

        /**
         * Emit the changestream into the collections change stream
         */
        const databaseStorageToken = await database.storageToken;
        const subLocalDocs = storageInstance.changeStream().subscribe(eventBulk => {
            const changeEventBulk: RxChangeEventBulk<RxLocalDocumentData> = {
                id: eventBulk.id,
                internal: false,
                collectionName: parent.database ? parent.name : undefined,
                storageToken: databaseStorageToken,
                events: eventBulk.events.map(ev => storageChangeEventToRxChangeEvent(
                    true,
                    ev,
                    parent.database ? parent as any : undefined
                )),
                databaseToken: database.token
            };
            database.$emit(changeEventBulk);
        });
        parent._subs.push(subLocalDocs);

        return {
            database,
            parent,
            storageInstance,
            docCache
        }
    })();
    LOCAL_DOC_STATE_BY_PARENT.set(parent, statePromise);
}

export function getLocalDocStateByParent(parent: LocalDocumentParent): Promise<LocalDocumentState> {
    const statePromise = LOCAL_DOC_STATE_BY_PARENT.get(parent);
    if (!statePromise) {
        const database: RxDatabase = parent.database ? parent.database : parent as any;
        const collectionName = parent.database ? parent.name : '';
        throw newRxError('LD8', {
            database: database.name,
            collection: collectionName
        });
    }
    return statePromise;
}


export function createLocalDocumentStorageInstance(
    databaseInstanceToken: string,
    storage: RxStorage<any, any>,
    databaseName: string,
    collectionName: string,
    instanceCreationOptions: any,
    multiInstance: boolean
) {
    return storage.createStorageInstance<RxLocalDocumentData>({
        databaseInstanceToken,
        databaseName: databaseName,
        /**
         * Use a different collection name for the local documents instance
         * so that the local docs can be kept while deleting the normal instance
         * after migration.
         */
        collectionName: getCollectionLocalInstanceName(collectionName),
        schema: RX_LOCAL_DOCUMENT_SCHEMA,
        options: instanceCreationOptions,
        multiInstance
    });
}

export function closeStateByParent(parent: LocalDocumentParent) {
    const statePromise = LOCAL_DOC_STATE_BY_PARENT.get(parent);
    if (statePromise) {
        LOCAL_DOC_STATE_BY_PARENT.delete(parent);
        return statePromise.then(state => state.storageInstance.close());
    }
}

export async function removeLocalDocumentsStorageInstance(
    storage: RxStorage<any, any>,
    databaseName: string,
    collectionName: string
) {
    const databaseInstanceToken = randomCouchString(10);
    const storageInstance = await createLocalDocumentStorageInstance(
        databaseInstanceToken,
        storage,
        databaseName,
        collectionName,
        {},
        false
    );
    await storageInstance.remove();
}


export function getCollectionLocalInstanceName(collectionName: string): string {
    return 'plugin-local-documents-' + collectionName;
}

export const RX_LOCAL_DOCUMENT_SCHEMA: RxJsonSchema<RxDocumentData<RxLocalDocumentData>> = fillWithDefaultSettings({
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id: {
            type: 'string'
        },
        data: {
            type: 'object',
            additionalProperties: true
        }
    },
    required: [
        'id',
        'data'
    ]
});
