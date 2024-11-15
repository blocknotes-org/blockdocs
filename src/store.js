import { createReduxStore, register, combineReducers } from '@wordpress/data';
import { serialize, parse } from '@wordpress/blocks';
import { store as noticesStore } from '@wordpress/notices';
import JSZip from 'jszip';

const EMPTY_ARRAY = [];
const postObject = {
	id: 1,
	title: 'Unsaved Document',
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
		canUser: () => {
			return true;
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
		hasUndo: () => {},
		hasRedo: () => {},
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
	},
	actions: {
		editEntityRecord: (kind, type, id, attributes) => {
			return {
				type: 'EDIT_ENTITY_RECORD',
				attributes,
			};
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
					const content = serialize(blocks);
					let fileHandle = select.getFileHandle();

					if (!fileHandle) {
						const options = {
							types: [
								{
									description: 'HTML Files',
									accept: {
										'application/zip': ['.blockdoc'],
									},
								},
							],
							suggestedName: 'new.blockdoc',
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
					const zip = new JSZip();
					zip.file('index.html', content);
					for (const [id, blob] of images.entries()) {
						zip.file(id, blob);
					}
					const blob = await zip.generateAsync({ type: 'blob' });
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
		__unstableCreateUndoLevel: () => {
			return { type: 'CREATE_UNDO_LEVEL' };
		},
		setFile:
			(fileHandle) =>
			async ({ dispatch }) => {
				const file = await fileHandle.getFile();
				const zip = await JSZip.loadAsync(file);
				const index = zip.file('index.html');
				const text = await index.async('string');
				const doc = document.implementation.createHTMLDocument();
				doc.body.innerHTML = text;
				for (const img of doc.querySelectorAll('img')) {
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
						title: fileHandle.name,
					},
				});
				await dispatch({
					type: 'SET_FILE_HANDLE',
					fileHandle,
				});
			},
	},
	resolvers: {},
});
register(newStore);
