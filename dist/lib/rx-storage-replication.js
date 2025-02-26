"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getAssumedMasterState = exports.awaitRxStorageReplicationIdle = exports.awaitRxStorageReplicationFirstInSync = exports.RX_REPLICATION_META_INSTANCE_SCHEMA = void 0;
exports.getCheckpointKey = getCheckpointKey;
exports.getLastCheckpointDoc = void 0;
exports.getMetaWriteRow = getMetaWriteRow;
exports.replicateRxStorageInstance = replicateRxStorageInstance;
exports.setCheckpoint = exports.resolveConflictError = void 0;
exports.startReplicationDownstream = startReplicationDownstream;
exports.startReplicationUpstream = startReplicationUpstream;

var _rxjs = require("rxjs");

var _rxSchemaHelper = require("./rx-schema-helper");

var _rxStorageHelper = require("./rx-storage-helper");

var _util = require("./util");

function _settle(pact, state, value) {
  if (!pact.s) {
    if (value instanceof _Pact) {
      if (value.s) {
        if (state & 1) {
          state = value.s;
        }

        value = value.v;
      } else {
        value.o = _settle.bind(null, pact, state);
        return;
      }
    }

    if (value && value.then) {
      value.then(_settle.bind(null, pact, state), _settle.bind(null, pact, 2));
      return;
    }

    pact.s = state;
    pact.v = value;
    var observer = pact.o;

    if (observer) {
      observer(pact);
    }
  }
}

var _Pact = /*#__PURE__*/function () {
  function _Pact() {}

  _Pact.prototype.then = function (onFulfilled, onRejected) {
    var result = new _Pact();
    var state = this.s;

    if (state) {
      var callback = state & 1 ? onFulfilled : onRejected;

      if (callback) {
        try {
          _settle(result, 1, callback(this.v));
        } catch (e) {
          _settle(result, 2, e);
        }

        return result;
      } else {
        return this;
      }
    }

    this.o = function (_this) {
      try {
        var value = _this.v;

        if (_this.s & 1) {
          _settle(result, 1, onFulfilled ? onFulfilled(value) : value);
        } else if (onRejected) {
          _settle(result, 1, onRejected(value));
        } else {
          _settle(result, 2, value);
        }
      } catch (e) {
        _settle(result, 2, e);
      }
    };

    return result;
  };

  return _Pact;
}();

function _isSettledPact(thenable) {
  return thenable instanceof _Pact && thenable.s & 1;
}

function _for(test, update, body) {
  var stage;

  for (;;) {
    var shouldContinue = test();

    if (_isSettledPact(shouldContinue)) {
      shouldContinue = shouldContinue.v;
    }

    if (!shouldContinue) {
      return result;
    }

    if (shouldContinue.then) {
      stage = 0;
      break;
    }

    var result = body();

    if (result && result.then) {
      if (_isSettledPact(result)) {
        result = result.s;
      } else {
        stage = 1;
        break;
      }
    }

    if (update) {
      var updateValue = update();

      if (updateValue && updateValue.then && !_isSettledPact(updateValue)) {
        stage = 2;
        break;
      }
    }
  }

  var pact = new _Pact();

  var reject = _settle.bind(null, pact, 2);

  (stage === 0 ? shouldContinue.then(_resumeAfterTest) : stage === 1 ? result.then(_resumeAfterBody) : updateValue.then(_resumeAfterUpdate)).then(void 0, reject);
  return pact;

  function _resumeAfterBody(value) {
    result = value;

    do {
      if (update) {
        updateValue = update();

        if (updateValue && updateValue.then && !_isSettledPact(updateValue)) {
          updateValue.then(_resumeAfterUpdate).then(void 0, reject);
          return;
        }
      }

      shouldContinue = test();

      if (!shouldContinue || _isSettledPact(shouldContinue) && !shouldContinue.v) {
        _settle(pact, 1, result);

        return;
      }

      if (shouldContinue.then) {
        shouldContinue.then(_resumeAfterTest).then(void 0, reject);
        return;
      }

      result = body();

      if (_isSettledPact(result)) {
        result = result.v;
      }
    } while (!result || !result.then);

    result.then(_resumeAfterBody).then(void 0, reject);
  }

  function _resumeAfterTest(shouldContinue) {
    if (shouldContinue) {
      result = body();

      if (result && result.then) {
        result.then(_resumeAfterBody).then(void 0, reject);
      } else {
        _resumeAfterBody(result);
      }
    } else {
      _settle(pact, 1, result);
    }
  }

  function _resumeAfterUpdate() {
    if (shouldContinue = test()) {
      if (shouldContinue.then) {
        shouldContinue.then(_resumeAfterTest).then(void 0, reject);
      } else {
        _resumeAfterTest(shouldContinue);
      }
    } else {
      _settle(pact, 1, result);
    }
  }
}

/**
 * Replicates two RxStorageInstances
 * with each other.
 * 
 * Compared to the 'normal' replication plugins,
 * this one is made for internal use where:
 * - No permission handling is needed.
 * - It is made so that the write amount on the master is less but might increase on the child.
 * - It does not have to be easy to implement a compatible backend.
 *   Here we use another RxStorageImplementation as replication goal
 *   so it has to exactly behave like the RxStorage interface defines.
 * 
 * This is made to be used internally by plugins
 * to get a really fast replication performance.
 * 
 * The replication works like git, where the fork contains all new writes
 * and must be merged with the master before it can push it's new state to the master.
 */
var getAssumedMasterState = function getAssumedMasterState(state, docIds) {
  try {
    return Promise.resolve(state.input.metaInstance.findDocumentsById(docIds.map(function (docId) {
      var useId = (0, _rxSchemaHelper.getComposedPrimaryKeyOfDocumentData)(RX_REPLICATION_META_INSTANCE_SCHEMA, {
        itemId: docId,
        replicationIdentifier: state.checkpointKey,
        isCheckpoint: '0'
      });
      return useId;
    }), true)).then(function (metaDocs) {
      var ret = {};
      Object.values(metaDocs).forEach(function (metaDoc) {
        ret[metaDoc.itemId] = {
          docData: metaDoc.data,
          metaDocument: metaDoc
        };
      });
      return ret;
    });
  } catch (e) {
    return Promise.reject(e);
  }
};

exports.getAssumedMasterState = getAssumedMasterState;

var awaitRxStorageReplicationIdle = function awaitRxStorageReplicationIdle(state) {
  return Promise.resolve(awaitRxStorageReplicationFirstInSync(state)).then(function () {
    var _exit = false;
    return _for(function () {
      return !_exit;
    }, void 0, function () {
      var _state$streamQueue = state.streamQueue,
          down = _state$streamQueue.down,
          up = _state$streamQueue.up;
      return Promise.resolve(Promise.all([up, down])).then(function () {
        if (down === state.streamQueue.down && up === state.streamQueue.up) {
          _exit = true;
        }
      });
      /**
       * If the Promises have not been reasigned
       * after awaiting them, we know that the replication
       * is in idle state at this point in time.
       */
    });
  });
};

exports.awaitRxStorageReplicationIdle = awaitRxStorageReplicationIdle;

var awaitRxStorageReplicationFirstInSync = function awaitRxStorageReplicationFirstInSync(state) {
  try {
    return Promise.resolve((0, _rxjs.firstValueFrom)((0, _rxjs.combineLatest)([state.firstSyncDone.down.pipe((0, _rxjs.filter)(function (v) {
      return !!v;
    })), state.firstSyncDone.up.pipe((0, _rxjs.filter)(function (v) {
      return !!v;
    }))])));
  } catch (e) {
    return Promise.reject(e);
  }
};

exports.awaitRxStorageReplicationFirstInSync = awaitRxStorageReplicationFirstInSync;

var setCheckpoint = function setCheckpoint(state, direction, checkpointDoc) {
  try {
    var checkpoint = state.lastCheckpoint[direction];

    var _temp18 = function () {
      if (checkpoint &&
      /**
       * If the replication is already canceled,
       * we do not write a checkpoint
       * because that could mean we write a checkpoint
       * for data that has been fetched from the master
       * but not been written to the child.
       */
      !state.canceled.getValue() && (
      /**
       * Only write checkpoint if it is different from before
       * to have less writes to the storage.
       */
      !checkpointDoc || JSON.stringify(checkpointDoc.data) !== JSON.stringify(checkpoint))) {
        var newDoc = {
          id: '',
          isCheckpoint: '1',
          itemId: direction,
          replicationIdentifier: state.checkpointKey,
          _deleted: false,
          _attachments: {},
          data: checkpoint,
          _meta: {
            lwt: (0, _util.now)()
          },
          _rev: (0, _util.getDefaultRevision)()
        };
        newDoc.id = (0, _rxSchemaHelper.getComposedPrimaryKeyOfDocumentData)(RX_REPLICATION_META_INSTANCE_SCHEMA, newDoc);
        newDoc._rev = (0, _util.createRevision)(newDoc, checkpointDoc);
        return Promise.resolve(state.input.metaInstance.bulkWrite([{
          previous: checkpointDoc,
          document: newDoc
        }])).then(function () {});
      }
    }();

    return Promise.resolve(_temp18 && _temp18.then ? _temp18.then(function () {}) : void 0);
  } catch (e) {
    return Promise.reject(e);
  }
};

exports.setCheckpoint = setCheckpoint;

/**
 * Resolves a conflict error.
 * Returns the resolved document that must be written to the fork.
 * Then the new document state can be pushed upstream.
 * If document is not in conflict, returns undefined.
 * If error is non-409, it throws an error.
 * Conflicts are only solved in the upstream, never in the downstream.
 */
var resolveConflictError = function resolveConflictError(conflictHandler, error) {
  try {
    if (error.status !== 409) {
      /**
       * If this ever happens,
       * make a PR with a unit test to reproduce it.
       */
      throw new Error('Non conflict error');
    }

    var documentInDb = (0, _util.ensureNotFalsy)(error.documentInDb);

    if (documentInDb._rev === error.writeRow.document._rev) {
      /**
       * Documents are equal,
       * so this is not a conflict -> do nothing.
       */
      return Promise.resolve(undefined);
    } else {
      /**
       * We have a conflict, resolve it!
       */
      return Promise.resolve(conflictHandler({
        assumedMasterState: error.writeRow.previous,
        newDocumentState: error.writeRow.document,
        realMasterState: documentInDb
      })).then(function (resolved) {
        var resolvedDoc = (0, _rxStorageHelper.flatCloneDocWithMeta)(resolved.resolvedDocumentState);
        resolvedDoc._meta.lwt = (0, _util.now)();
        resolvedDoc._rev = (0, _util.createRevision)(resolvedDoc, error.writeRow.document);
        return resolvedDoc;
      });
    }
  } catch (e) {
    return Promise.reject(e);
  }
};

exports.resolveConflictError = resolveConflictError;

var getLastCheckpointDoc = function getLastCheckpointDoc(state, direction) {
  try {
    var checkpointDocId = (0, _rxSchemaHelper.getComposedPrimaryKeyOfDocumentData)(RX_REPLICATION_META_INSTANCE_SCHEMA, {
      isCheckpoint: '1',
      itemId: direction,
      replicationIdentifier: state.checkpointKey
    });
    return Promise.resolve(state.input.metaInstance.findDocumentsById([checkpointDocId], false)).then(function (checkpointResult) {
      var checkpointDoc = checkpointResult[checkpointDocId];

      if (checkpointDoc) {
        return {
          checkpoint: checkpointDoc.data,
          checkpointDoc: checkpointDoc
        };
      } else {
        return undefined;
      }
    });
  } catch (e) {
    return Promise.reject(e);
  }
};

exports.getLastCheckpointDoc = getLastCheckpointDoc;

/**
 * Flags that a document state was written to the master
 * by the upstream from the fork.
 * Used in the ._meta of the document data that is stored at the master
 * and contains only the revision.
 * We need this to detect if the document state was written from the upstream
 * so that it is not again replicated to the downstream.
 * TODO instead of doing that, we should have a way to 'mark' bulkWrite()
 * calls so that the emitted events can be detected as being from the upstream.
 */
var FROM_FORK_FLAG_SUFFIX = '-fork';
var RX_REPLICATION_META_INSTANCE_SCHEMA = (0, _rxSchemaHelper.fillWithDefaultSettings)({
  primaryKey: {
    key: 'id',
    fields: ['replicationIdentifier', 'itemId', 'isCheckpoint'],
    separator: '|'
  },
  type: 'object',
  version: 0,
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 100
    },
    replicationIdentifier: {
      type: 'string'
    },
    isCheckpoint: {
      type: 'string',
      "enum": ['0', '1'],
      maxLength: 1
    },
    itemId: {
      type: 'string'
    },
    data: {
      type: 'object',
      additionalProperties: true
    }
  },
  required: ['id', 'replicationIdentifier', 'isCheckpoint', 'itemId', 'data']
});
exports.RX_REPLICATION_META_INSTANCE_SCHEMA = RX_REPLICATION_META_INSTANCE_SCHEMA;

function replicateRxStorageInstance(input) {
  var state = {
    primaryPath: (0, _rxSchemaHelper.getPrimaryFieldOfPrimaryKey)(input.masterInstance.schema.primaryKey),
    input: input,
    checkpointKey: getCheckpointKey(input),
    canceled: new _rxjs.BehaviorSubject(false),
    firstSyncDone: {
      down: new _rxjs.BehaviorSubject(false),
      up: new _rxjs.BehaviorSubject(false)
    },
    lastCheckpoint: {},
    streamQueue: {
      down: _util.PROMISE_RESOLVE_VOID,
      up: _util.PROMISE_RESOLVE_VOID
    }
  };
  startReplicationDownstream(state);
  startReplicationUpstream(state);
  return state;
}
/**
 * Writes all documents from the master to the fork.
 */


function startReplicationDownstream(state) {
  var downstreamSyncOnce = function downstreamSyncOnce() {
    try {
      if (state.canceled.getValue()) {
        return Promise.resolve();
      }

      return Promise.resolve(getLastCheckpointDoc(state, 'down')).then(function (checkpointState) {
        function _temp2() {
          return Promise.resolve(writeToChildQueue).then(function () {
            if (!state.firstSyncDone.down.getValue()) {
              state.firstSyncDone.down.next(true);
            }
            /**
             * Write the new checkpoint
             */


            return Promise.resolve(setCheckpoint(state, 'down', lastCheckpointDoc)).then(function () {});
          });
        }

        var lastCheckpointDoc = checkpointState ? checkpointState.checkpointDoc : undefined;
        var done = false;

        var _temp = _for(function () {
          return !done && !state.canceled.getValue();
        }, void 0, function () {
          return Promise.resolve(state.input.masterInstance.getChangedDocumentsSince(state.input.bulkSize, state.lastCheckpoint.down)).then(function (downResult) {
            if (downResult.length === 0) {
              done = true;
              return;
            }

            var useDownDocs = downResult.map(function (r) {
              return r.document;
            });
            state.lastCheckpoint.down = (0, _util.lastOfArray)(downResult).checkpoint;
            writeToChildQueue = writeToChildQueue.then(function () {
              try {
                var downDocsById = {};
                var docIds = useDownDocs.map(function (d) {
                  var id = d[state.primaryPath];
                  downDocsById[id] = d;
                  return id;
                });
                return Promise.resolve(Promise.all([state.input.forkInstance.findDocumentsById(docIds, true), getAssumedMasterState(state, docIds)])).then(function (_ref) {
                  var currentForkState = _ref[0],
                      assumedMasterState = _ref[1];

                  function _temp5() {
                    var _temp3 = function () {
                      if (useMetaWriteRows.length > 0) {
                        return Promise.resolve(state.input.metaInstance.bulkWrite(useMetaWriteRows)).then(function () {});
                      }
                    }();

                    if (_temp3 && _temp3.then) return _temp3.then(function () {});
                  }

                  var writeRowsToFork = [];
                  var writeRowsToMeta = {};
                  var useMetaWriteRows = [];
                  docIds.forEach(function (docId) {
                    var forkState = currentForkState[docId];
                    var masterState = downDocsById[docId];
                    var assumedMaster = assumedMasterState[docId];

                    if (forkState && assumedMaster && assumedMaster.docData._rev !== forkState._rev || forkState && !assumedMaster) {
                      /**
                       * We have a non-upstream-replicated
                       * local write to the fork.
                       * This means we ignore the downstream of this document
                       * because anyway the upstream will first resolve the conflict.
                       */
                      return;
                    }

                    if (forkState && forkState._rev === masterState._rev) {
                      /**
                       * Document states are exactly equal.
                       * This can happen when the replication is shut down
                       * unexpected like when the user goes offline.
                       * 
                       * Only when the assumedMaster is differnt from the forkState,
                       * we have to patch the document in the meta instance.
                       */
                      if (!assumedMaster || assumedMaster.docData._rev !== forkState._rev) {
                        useMetaWriteRows.push(getMetaWriteRow(state, forkState, assumedMaster ? assumedMaster.metaDocument : undefined));
                      }

                      return;
                    }
                    /**
                     * All other master states need to be written to the forkInstance
                     * and metaInstance.
                     */


                    writeRowsToFork.push({
                      previous: forkState,
                      document: masterState
                    });
                    writeRowsToMeta[docId] = getMetaWriteRow(state, masterState, assumedMaster ? assumedMaster.metaDocument : undefined);
                  });

                  var _temp4 = function () {
                    if (writeRowsToFork.length > 0) {
                      return Promise.resolve(state.input.forkInstance.bulkWrite(writeRowsToFork)).then(function (forkWriteResult) {
                        Object.keys(forkWriteResult.success).forEach(function (docId) {
                          useMetaWriteRows.push(writeRowsToMeta[docId]);
                        });
                      });
                    }
                  }();

                  return _temp4 && _temp4.then ? _temp4.then(_temp5) : _temp5(_temp4);
                });
              } catch (e) {
                return Promise.reject(e);
              }
            });
          });
        });

        return _temp && _temp.then ? _temp.then(_temp2) : _temp2(_temp);
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  var inQueueCount = 0;
  state.streamQueue.down = state.streamQueue.down.then(function () {
    return downstreamSyncOnce();
  });

  function addRunAgain() {
    if (inQueueCount > 2) {
      return;
    }

    inQueueCount = inQueueCount + 1;
    state.streamQueue.down = state.streamQueue.down.then(function () {
      return downstreamSyncOnce();
    })["catch"](function () {}).then(function () {
      return inQueueCount = inQueueCount - 1;
    });
  }
  /**
   * If a write on the master happens, we have to trigger the downstream.
   */


  var sub = state.input.masterInstance.changeStream().subscribe(function () {
    addRunAgain();
  });
  (0, _rxjs.firstValueFrom)(state.canceled.pipe((0, _rxjs.filter)(function (canceled) {
    return !!canceled;
  }))).then(function () {
    return sub.unsubscribe();
  });
  /**
   * For faster performance, we directly start each write
   * and then await all writes at the end.
   */

  var writeToChildQueue = _util.PROMISE_RESOLVE_VOID;
}
/**
 * Writes all document changes from the client to the master.
 */


function startReplicationUpstream(state) {
  var upstreamSyncOnce = function upstreamSyncOnce() {
    try {
      if (state.canceled.getValue()) {
        return Promise.resolve();
      }

      return Promise.resolve(getLastCheckpointDoc(state, 'up')).then(function (checkpointState) {
        function _temp11() {
          return Promise.resolve(writeToMasterQueue).then(function () {
            return Promise.resolve(setCheckpoint(state, 'up', lastCheckpointDoc)).then(function () {
              if (!hadConflictWrites && !state.firstSyncDone.up.getValue()) {
                state.firstSyncDone.up.next(true);
              }
            });
          });
        }

        var lastCheckpointDoc = checkpointState ? checkpointState.checkpointDoc : undefined;
        /**
         * If this goes to true,
         * it means that we have to do a new write to the
         * fork instance to resolve a conflict.
         * In that case, state.firstSyncDone.up
         * must not be set to true, because
         * an additional upstream cycle must be used
         * to push the resolved conflict state.
         */

        var hadConflictWrites = false;
        var done = false;

        var _temp10 = _for(function () {
          return !done && !state.canceled.getValue();
        }, void 0, function () {
          return Promise.resolve(state.input.forkInstance.getChangedDocumentsSince(state.input.bulkSize, state.lastCheckpoint.up)).then(function (upResult) {
            if (upResult.length === 0 || state.canceled.getValue()) {
              done = true;
              return;
            }

            state.lastCheckpoint.up = (0, _util.lastOfArray)(upResult).checkpoint;
            writeToMasterQueue = writeToMasterQueue.then(function () {
              try {
                // used to not have infinity loop during development
                // that cannot be exited via Ctrl+C
                // await promiseWait(0);
                if (state.canceled.getValue()) {
                  return Promise.resolve();
                }

                var useUpDocs = upResult.map(function (r) {
                  return r.document;
                });

                if (useUpDocs.length === 0) {
                  return Promise.resolve();
                }

                return Promise.resolve(getAssumedMasterState(state, useUpDocs.map(function (d) {
                  return d[state.primaryPath];
                }))).then(function (assumedMasterState) {
                  var writeRowsToMaster = [];
                  var writeRowsToMeta = {};
                  useUpDocs.forEach(function (doc) {
                    var docId = doc[state.primaryPath];
                    var useDoc = (0, _rxStorageHelper.flatCloneDocWithMeta)(doc);
                    useDoc._meta[state.checkpointKey + FROM_FORK_FLAG_SUFFIX] = useDoc._rev;
                    useDoc._meta.lwt = (0, _util.now)();
                    var assumedMasterDoc = assumedMasterState[docId];
                    /**
                     * If the master state is equal to the
                     * fork state, we can assume that the document state is already
                     * replicated.
                     */

                    if (assumedMasterDoc && assumedMasterDoc.docData._rev === useDoc._rev) {
                      return;
                    }
                    /**
                     * If the assumed master state has a heigher revision height
                     * then the current document state,
                     * we can assume that a downstream replication has happend in between
                     * and we can drop this upstream replication.
                     * 
                     * TODO there is no real reason why this should ever happen,
                     * however the replication did not work on the PouchDB RxStorage
                     * without this fix.
                     */


                    if (assumedMasterDoc && (0, _util.parseRevision)(assumedMasterDoc.docData._rev).height >= (0, _util.parseRevision)(useDoc._rev).height) {
                      return;
                    }

                    writeRowsToMaster.push({
                      previous: assumedMasterDoc ? assumedMasterDoc.docData : undefined,
                      document: useDoc
                    });
                    writeRowsToMeta[docId] = getMetaWriteRow(state, useDoc, assumedMasterDoc ? assumedMasterDoc.metaDocument : undefined);
                  });

                  if (writeRowsToMaster.length === 0) {
                    return;
                  }

                  return Promise.resolve(state.input.masterInstance.bulkWrite(writeRowsToMaster)).then(function (masterWriteResult) {
                    function _temp16() {
                      var _temp14 = function () {
                        if (Object.keys(masterWriteResult.error).length > 0) {
                          var conflictWriteFork = [];
                          var conflictWriteMeta = {};
                          return Promise.resolve(Promise.all(Object.entries(masterWriteResult.error).map(function (_ref2) {
                            try {
                              var _docId = _ref2[0],
                                  error = _ref2[1];
                              return Promise.resolve(resolveConflictError(state.input.conflictHandler, error)).then(function (resolved) {
                                if (resolved) {
                                  conflictWriteFork.push({
                                    previous: error.writeRow.document,
                                    document: resolved
                                  });
                                }

                                var assumedMasterDoc = assumedMasterState[_docId];
                                conflictWriteMeta[_docId] = getMetaWriteRow(state, (0, _util.ensureNotFalsy)(error.documentInDb), assumedMasterDoc ? assumedMasterDoc.metaDocument : undefined);
                              });
                            } catch (e) {
                              return Promise.reject(e);
                            }
                          }))).then(function () {
                            var _temp13 = function () {
                              if (conflictWriteFork.length > 0) {
                                hadConflictWrites = true;
                                return Promise.resolve(state.input.forkInstance.bulkWrite(conflictWriteFork)).then(function (forkWriteResult) {
                                  /**
                                   * Errors in the forkWriteResult must not be handled
                                   * because they have been caused by a write to the forkInstance
                                   * in between which will anyway trigger a new upstream cycle
                                   * that will then resolved the conflict again.
                                   */
                                  var useMetaWrites = [];
                                  Object.keys(forkWriteResult.success).forEach(function (docId) {
                                    useMetaWrites.push(conflictWriteMeta[docId]);
                                  });

                                  var _temp12 = function () {
                                    if (useMetaWrites.length > 0) {
                                      return Promise.resolve(state.input.metaInstance.bulkWrite(useMetaWrites)).then(function () {});
                                    }
                                  }();

                                  if (_temp12 && _temp12.then) return _temp12.then(function () {});
                                }); // TODO what to do with conflicts while writing to the metaInstance?
                              }
                            }();

                            if (_temp13 && _temp13.then) return _temp13.then(function () {});
                          });
                        }
                      }();

                      if (_temp14 && _temp14.then) return _temp14.then(function () {});
                    }

                    var useWriteRowsToMeta = [];
                    Object.keys(masterWriteResult.success).forEach(function (docId) {
                      useWriteRowsToMeta.push(writeRowsToMeta[docId]);
                    });

                    var _temp15 = function () {
                      if (useWriteRowsToMeta.length > 0) {
                        return Promise.resolve(state.input.metaInstance.bulkWrite(useWriteRowsToMeta)).then(function () {}); // TODO what happens when we have conflicts here?
                      }
                    }();

                    return _temp15 && _temp15.then ? _temp15.then(_temp16) : _temp16(_temp15);
                    /**
                     * Resolve conflicts by writing a new document
                     * state to the fork instance and the 'real' master state
                     * to the meta instance.
                     * Non-409 errors will be detected by resolveConflictError()
                     */
                  });
                });
              } catch (e) {
                return Promise.reject(e);
              }
            });
          });
        });

        return _temp10 && _temp10.then ? _temp10.then(_temp11) : _temp11(_temp10);
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  var writeToMasterQueue = _util.PROMISE_RESOLVE_VOID;
  var inQueueCount = 0;
  state.streamQueue.up = state.streamQueue.up.then(function () {
    return upstreamSyncOnce();
  });

  function addRunAgain() {
    if (inQueueCount > 2) {
      return state.streamQueue.up;
    }

    inQueueCount = inQueueCount + 1;
    state.streamQueue.up = state.streamQueue.up.then(function () {
      return upstreamSyncOnce();
    })["catch"](function () {}).then(function () {
      return inQueueCount = inQueueCount - 1;
    });
    return state.streamQueue.up;
  }

  var sub = state.input.forkInstance.changeStream().subscribe(function () {
    try {
      var _temp8 = function _temp8() {
        addRunAgain();
      };

      var _temp9 = function () {
        if (state.input.waitBeforePersist) {
          return Promise.resolve(state.input.waitBeforePersist()).then(function () {});
        }
      }();

      return Promise.resolve(_temp9 && _temp9.then ? _temp9.then(_temp8) : _temp8(_temp9));
    } catch (e) {
      return Promise.reject(e);
    }
  });
  (0, _rxjs.firstValueFrom)(state.canceled.pipe((0, _rxjs.filter)(function (canceled) {
    return !!canceled;
  }))).then(function () {
    return sub.unsubscribe();
  });
}

function getCheckpointKey(input) {
  var hash = (0, _util.fastUnsecureHash)([input.identifier, input.masterInstance.storage.name, input.masterInstance.databaseName, input.masterInstance.collectionName, input.forkInstance.storage.name, input.forkInstance.databaseName, input.forkInstance.collectionName].join('||'));
  return 'rx-storage-replication-' + hash;
}

function getMetaWriteRow(state, newMasterDocState, previous) {
  var docId = newMasterDocState[state.primaryPath];
  var newMeta = previous ? (0, _rxStorageHelper.flatCloneDocWithMeta)(previous) : {
    id: '',
    replicationIdentifier: state.checkpointKey,
    isCheckpoint: '0',
    itemId: docId,
    data: newMasterDocState,
    _attachments: {},
    _deleted: false,
    _rev: (0, _util.getDefaultRevision)(),
    _meta: {
      lwt: 0
    }
  };
  newMeta.data = newMasterDocState;
  newMeta._rev = (0, _util.createRevision)(newMeta, previous);
  newMeta._meta.lwt = (0, _util.now)();
  newMeta.id = (0, _rxSchemaHelper.getComposedPrimaryKeyOfDocumentData)(RX_REPLICATION_META_INSTANCE_SCHEMA, newMeta);
  return {
    previous: previous,
    document: newMeta
  };
}
//# sourceMappingURL=rx-storage-replication.js.map