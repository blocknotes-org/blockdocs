import { createReduxStore, register, combineReducers } from '@wordpress/data';
import { serialize, parse } from '@wordpress/blocks';
import { store as noticesStore } from '@wordpress/notices';
import { createUndoManager } from '@wordpress/undo-manager';
import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';

import { EPUB_MIME_TYPE, createEPub } from './epub';
import { downloadFile } from './file';

const EMPTY_ARRAY = [];
const postObject = {
	id: 1,
	title: 'Untitled Document',
	content: '',
	status: 'draft',
	_links: {
		'wp:action-publish': true,
	},
};
const postTypeObject = {
	labels: {},
	supports: {},
};

async function extractImages(blocks) {
	const images = new Map();
	const newBlocks = await Promise.all(
		blocks.map(async (block) => {
			const { innerBlocks = [], attributes, name } = block;
			const [newInnerBlocks, moreImages] = await extractImages(
				innerBlocks,
				images
			);
			for (const image of moreImages) {
				images.set(image.id, image);
			}
			if (name === 'core/image' && attributes.url) {
				const relPath = attributes.url
					.split('/')
					.pop()
					.replace('#', '.');
				images.set(
					relPath,
					await fetch(attributes.url).then((r) => r.blob())
				);
				return {
					...block,
					innerBlocks: newInnerBlocks,
					attributes: {
						...attributes,
						url: relPath,
						id: undefined,
					},
				};
			}
			return {
				...block,
				innerBlocks: newInnerBlocks,
			};
		})
	);
	return [newBlocks, images];
}

const newStore = createReduxStore('core', {
	reducer: combineReducers({
		post: (state = postObject, action) => {
			switch (action.type) {
				case 'EDIT_ENTITY_RECORD':
					return { ...state, ...action.attributes };
				case 'UNDO': {
					const record = action.record.find((r) => r.id === 'object');
					return {
						...state,
						...Object.keys(record.changes).reduce((acc, key) => {
							acc[key] = record.changes[key].from;
							return acc;
						}, {}),
					};
				}
				case 'REDO': {
					const record = action.record.find((r) => r.id === 'object');
					return {
						...state,
						...Object.keys(record.changes).reduce((acc, key) => {
							acc[key] = record.changes[key].to;
							return acc;
						}, {}),
					};
				}
			}
			return state;
		},
		fileHandle: (state = null, action) => {
			switch (action.type) {
				case 'SET_FILE_HANDLE':
					return action.fileHandle;
			}
			return state;
		},
		undoManager: (state = createUndoManager(), action) => {
			switch (action.type) {
				case 'CLEAR_UNDO_MANAGER':
					return createUndoManager();
			}
			return state;
		},
	}),
	selectors: {
		getEntityRecord: (state) => {
			return state.post;
		},
		getEntityRecords: () => {
			return EMPTY_ARRAY;
		},
		getEntityRecordEdits: (state) => {
			return state.post;
		},
		getRawEntityRecord: (state) => {
			return state.post;
		},
		getEditedEntityRecord: (state) => {
			return state.post;
		},
		canUser: (state, action) => {
			return ['read', 'update', 'create'].includes(action);
		},
		getUserPatternCategories: () => {
			return EMPTY_ARRAY;
		},
		getBlockPatternCategories: () => {
			return EMPTY_ARRAY;
		},
		__experimentalGetCurrentGlobalStylesId: () => {},
		__experimentalGetCurrentThemeBaseGlobalStyles: () => {},
		getPostType: () => {
			return postTypeObject;
		},
		hasUndo: (state) => {
			return state.undoManager.hasUndo();
		},
		hasRedo: (state) => {
			return state.undoManager.hasRedo();
		},
		hasEditsForEntityRecord: () => {},
		getCurrentUser: () => {},
		getAutosave: () => {},
		__experimentalGetDirtyEntityRecords: () => {
			return EMPTY_ARRAY;
		},
		__experimentalGetEntitiesBeingSaved: () => {
			return EMPTY_ARRAY;
		},
		getEntityRecordPermissions: () => {},
		getThemeSupports: () => {},
		getUsers: () => {
			return EMPTY_ARRAY;
		},
		getTaxonomies: () => {
			return EMPTY_ARRAY;
		},
		getCurrentTheme: () => {},
		getBlockPatternsForPostType: () => {
			return EMPTY_ARRAY;
		},
		getEntityRecordNonTransientEdits: (state) => {
			return state.post;
		},
		getLastEntitySaveError: () => {
			return null;
		},
		getMedia: () => {},
		getFileHandle: (state) => {
			return state.fileHandle;
		},
		getUndoManager: (state) => {
			return state.undoManager;
		},
	},
	actions: {
		undo:
			() =>
			async ({ select, dispatch }) => {
				const undoRecord = select.getUndoManager().undo();
				if (!undoRecord) {
					return;
				}
				await dispatch({
					type: 'UNDO',
					record: undoRecord,
				});
			},
		redo:
			() =>
			async ({ select, dispatch }) => {
				const redoRecord = select.getUndoManager().redo();
				if (!redoRecord) {
					return;
				}
				await dispatch({
					type: 'REDO',
					record: redoRecord,
				});
			},
		editEntityRecord:
			(kind, type, id, attributes, options = {}) =>
			async ({ select, dispatch }) => {
				if (!options.undoIgnore) {
					const state = select.getEditedEntityRecord();
					select.getUndoManager().addRecord(
						[
							{
								id: 'object',
								changes: Object.keys(attributes).reduce(
									(acc, key) => {
										acc[key] = {
											from: state[key],
											to: attributes[key],
										};
										return acc;
									},
									{}
								),
							},
						],
						options.isCached
					);
				}
				await dispatch({
					type: 'EDIT_ENTITY_RECORD',
					attributes,
				});
			},
		saveEntityRecord:
			() =>
			async ({ select, dispatch, registry }) => {
				try {
					const post = select.getEditedEntityRecord();
					if (!post.blocks) {
						return;
					}
					const [blocks, images] = await extractImages(post.blocks);
					const chapters = blocks.filter(
						(block) =>
							block.name === 'core/heading' &&
							block.attributes.content
					);
					// Add chapter IDs to the blocks
					chapters.forEach((block) => {
						block.attributes.anchor = block.attributes.content
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, '-');
					});
					const content = serialize(blocks);
					const blob = await createEPub({
						title: post.title,
						uniqueId: uuidv4(),
						content,
						language: 'en',
						assets: images,
						nav: chapters.map((chapter) => ({
							title: chapter.attributes.content,
							level: chapter.attributes.level,
							href: `#${chapter.attributes.anchor}`,
						})),
					});

					let fileHandle = select.getFileHandle();

					if (!fileHandle) {
						if (!window.showSaveFilePicker) {
							downloadFile(blob, `${post.title}.epub`);
							registry
								.dispatch(noticesStore)
								.createSuccessNotice(
									'Item downloaded. Please use Chrome to write to an existing file.',
									{
										id: 'save-notice',
									}
								);
							return;
						}
						const options = {
							types: [
								{
									description:
										'A file to store your document.',
									accept: { [EPUB_MIME_TYPE]: ['.epub'] },
								},
							],
							suggestedName: `${post.title}.epub`,
						};
						fileHandle = await window.showSaveFilePicker(options);
						await dispatch({
							type: 'EDIT_ENTITY_RECORD',
							attributes: {
								title: fileHandle.name,
							},
						});
						await dispatch({
							type: 'SET_FILE_HANDLE',
							fileHandle,
						});
					}
					const writableStream = await fileHandle.createWritable();

					await writableStream.write(blob);
					await writableStream.close();
					registry
						.dispatch(noticesStore)
						.createSuccessNotice('Item updated', {
							id: 'save-notice',
						});
				} catch (e) {
					window.console.error(e);
				}
			},
		__unstableCreateUndoLevel:
			() =>
			({ select }) => {
				select.getUndoManager().addRecord();
			},
		setFile:
			(fileHandle) =>
			async ({ dispatch }) => {
				let file = fileHandle;
				if (fileHandle.getFile) {
					file = await fileHandle.getFile();
				}
				const zip = await JSZip.loadAsync(file);
				const index = zip.file('index.html');

				if (!index) {
					window.alert('This file was not created with this app.');
					return;
				}

				const text = await index.async('string');
				const doc = document.implementation.createHTMLDocument();
				doc.body.innerHTML = text;
				for (const img of doc.querySelectorAll('img')) {
					if (!img.src) {
						continue;
					}
					const ext = img.src.split('.').pop();
					img.src =
						URL.createObjectURL(
							await zip.file(img.src).async('blob')
						) +
						'#' +
						ext;
				}
				const blocks = parse(doc.body.innerHTML);

				await dispatch({
					type: 'EDIT_ENTITY_RECORD',
					attributes: {
						blocks,
						content: serialize(blocks),
						title: doc.title,
					},
				});
				dispatch({
					type: 'CLEAR_UNDO_MANAGER',
				});
				if (fileHandle?.getFile) {
					await dispatch({
						type: 'SET_FILE_HANDLE',
						fileHandle,
					});
				}
			},
	},
	resolvers: {},
});
register(newStore);
