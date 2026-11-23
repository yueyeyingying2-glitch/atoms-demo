import { connectPreview, openPreview } from './preview.js';

const frame = document.getElementById('shared-app');
const notice = document.getElementById('shared-notice');
connectPreview(frame);
void openPreview(frame, frame.dataset.project, {
  content: frame.dataset.content,
  state: frame.dataset.state,
  status(message) {
    const normal = /^(正在|工具记录已连接|工具记录已同步)/.test(message);
    notice.textContent = message;
    notice.hidden = !message || normal;
  }
});
