import assert from 'assert';
import { waitUntil } from 'async-test-util';
import {
    dbCount,
    BROADCAST_CHANNEL_BY_TOKEN
} from '../../';
import { OPEN_POUCHDB_STORAGE_INSTANCES } from '../../plugins/pouchdb';
import config from './config';

describe('last.test.ts (' + config.storage.name + ')', () => {
    it('ensure every db is cleaned up', () => {
        assert.strictEqual(dbCount(), 0);
    });
    it('ensure every storage instance is cleaned up', async () => {
        try {
            // for performance, we do not await db closing, so it might take some time
            // until everything is closed.
            await waitUntil(() => {
                return OPEN_POUCHDB_STORAGE_INSTANCES.size === 0;
            }, 5 * 1000, 500);
        } catch (err) {
            console.dir(OPEN_POUCHDB_STORAGE_INSTANCES);
            throw new Error('no all storage instances have been closed');
        }
    });
    it('ensure all BroadcastChannels are closed', () => {
        assert.strictEqual(
            BROADCAST_CHANNEL_BY_TOKEN.size,
            0
        );
    });
});
