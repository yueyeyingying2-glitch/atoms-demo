import { connectPreview, openPreview } from './preview.js';

const frame = document.getElementById('shared-app');
connectPreview(frame);
openPreview(frame, frame.dataset.project, true);
