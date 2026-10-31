// 前端页面沙箱：最小 DOM/元素实现与本地弹幕页加载
// 共享测试夹具：文件名不匹配 node --test 的发现规则，不会被当作测试执行。

import dotenv from 'dotenv';
dotenv.config();

import vm from 'node:vm';
import { localDanmuJsContent } from '../../ui/js/localdanmu.js';
import { HTML_TEMPLATE } from '../../ui/template.js';

export class TestElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.className = '';
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.value = '';
    this.required = false;
    this.validity = { badInput: false };
    this.style = {};
    this.attributes = {};
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...tokens) => { this.className = [...new Set([...classes(), ...tokens])].join(' '); },
      remove: (...tokens) => { this.className = classes().filter(token => !tokens.includes(token)).join(' '); },
      contains: token => classes().includes(token),
    };
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Uploaded metadata must be rendered as text'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  click() { this.clicked = true; }
  querySelectorAll(selector) {
    const matches = element => selector.startsWith('.')
      ? element.className.split(' ').includes(selector.slice(1)) : element.tagName === selector;
    return this.children.flatMap(child => [ ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector) ]);
  }
}

export function makePage(fetch, sandboxGlobals = {}, html) {
  const elements = new Map();
  const documentListeners = new Map();
  for (const name of ['file', 'title', 'year', 'type', 'season', 'episode', 'season-label', 'episode-label', 'fields', 'episode-field', 'batch-preview', 'batch-list', 'permission', 'upload-button', 'upload-status', 'search', 'list', 'edit-modal', 'edit-group-fields', 'edit-resource-fields', 'edit-name', 'edit-year', 'edit-type', 'edit-season', 'edit-episode', 'edit-filename', 'edit-status']) {
    elements.set(`local-danmu-${name}`, new TestElement());
  }
  const fileInput = (html || HTML_TEMPLATE).match(/<input\b[^>]*\bid="local-danmu-file"[^>]*>/)[0];
  elements.get('local-danmu-file').dataset.canUpload = html ? fileInput.match(/data-can-upload="([^"]*)"/)[1] : 'true';
  const context = vm.createContext({
    document: {
      createElement: tag => new TestElement(tag),
      getElementById: id => elements.get(id),
      addEventListener: (type, callback) => documentListeners.set(type, callback),
    },
    FormData,
    fetch,
    buildApiUrl: value => value,
    confirm: () => true,
    customAlert: () => {},
    currentToken: 'local-user-token',
    currentAdminToken: '',
    globals: { localDanmuRedisValid: true, localDanmuIsCloud: false },
    ...sandboxGlobals,
  });
  new vm.Script(localDanmuJsContent).runInContext(context);
  const chooseFile = vm.compileFunction(fileInput.match(/onclick="([^"]*)"/)[1], ['event'], { parsingContext: context });
  return { context, elements, documentListeners, chooseFile, box: elements.get('local-danmu-list') };
}

export function fillUploadForm(elements, fields = {}) {
  elements.get('local-danmu-file').files = [new File(['{}'], 'danmu.json')];
  for (const [name, value] of Object.entries({ title: '本地资源', year: '2026', type: 'tv', season: '1', episode: '5', ...fields })) {
    elements.get(`local-danmu-${name}`).value = value;
  }
}

