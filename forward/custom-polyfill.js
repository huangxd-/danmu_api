// Bundled forward danmu widget with all internal functions (excluding UI) from https://github.com/huangxd-/danmu_api.git

class URL {
  constructor(url, base) {
    if (base) {
      // 如果提供了基础URL，拼接相对路径
      if (url.startsWith('/')) {
        // 处理绝对路径形式
        const baseWithoutPath = base.replace(/\/[^\/]*$/, '');
        this._url = baseWithoutPath + url;
      } else if (url.startsWith('./') || !url.startsWith('http')) {
        // 处理相对路径
        const baseWithoutPath = base.replace(/\/[^\/]*$/, '');
        this._url = baseWithoutFile + '/' + url.replace('./', '');
      } else {
        this._url = url;
      }
    } else {
      this._url = url;
    }

    // 解析URL组件
    this.parseURL(this._url);
  }

  parseURL(url) {
    // 基础URL解析逻辑
    const match = url.match(/^([^:]+):\/\/([^\/]+)(.*)$/);
    if (match) {
      this.protocol = match[1] + ':';
      this.hostname = match[2];
      const pathAndQuery = match[3] || '';
      const queryIndex = pathAndQuery.indexOf('?');
      
      if (queryIndex !== -1) {
        this.pathname = pathAndQuery.substring(0, queryIndex);
        this.search = pathAndQuery.substring(queryIndex);
      } else {
        this.pathname = pathAndQuery;
        this.search = '';
      }
    } else {
      this.protocol = '';
      this.hostname = '';
      this.pathname = url;
      this.search = '';
    }
  }

  toString() {
    return this._url;
  }

  static createObjectURL(obj) {
    // 简单的模拟实现
    return 'blob:' + Date.now();
  }

  static revokeObjectURL(url) {
    // 简单的模拟实现
  }

  get href() {
    return this._url;
  }

  get origin() {
    return this.protocol + '//' + this.hostname;
  }

  get host() {
    return this.hostname;
  }

  get searchParams() {
    // 创建一个简单的SearchParams实现
    const paramsString = this.search.substring(1); // 移除开头的?
    const params = new (function() {
      const entries = {};
      if (paramsString) {
        paramsString.split('&').forEach(pair => {
          const [key, value] = pair.split('=');
          if (key) {
            entries[decodeURIComponent(key)] = decodeURIComponent(value || '');
          }
        });
      }

      this.get = (name) => entries[name] || null;
      this.set = (name, value) => { entries[name] = value.toString(); };
      this.toString = () => Object.keys(entries).map(key => 
        encodeURIComponent(key) + '=' + encodeURIComponent(entries[key])
      ).join('&');
    })();
    return params;
  }
}

class AbortController {
  constructor() {
    this.signal = new AbortSignal();
  }

  abort() {
    this.signal.abort();
  }
}

class AbortSignal {
  constructor() {
    this.aborted = false;
    this.onabort = null;
    this.listeners = [];
  }

  abort() {
    if (this.aborted) return;
    
    this.aborted = true;
    
    // 触发所有监听器
    this.listeners.forEach(listener => {
      try {
        if (typeof listener === 'function') {
          listener({ type: 'abort' });
        } else if (listener && typeof listener.handleEvent === 'function') {
          listener.handleEvent({ type: 'abort' });
        }
      } catch (e) {
        // 忽略监听器中的错误
      }
    });
    
    // 触发onabort回调
    if (this.onabort) {
      try {
        this.onabort({ type: 'abort' });
      } catch (e) {
        // 忽略onabort回调中的错误
      }
    }
  }

  addEventListener(type, listener) {
    if (type === 'abort') {
      this.listeners.push(listener);
      // 如果已经中止，立即触发监听器
      if (this.aborted) {
        try {
          if (typeof listener === 'function') {
            listener({ type: 'abort' });
          } else if (listener && typeof listener.handleEvent === 'function') {
            listener.handleEvent({ type: 'abort' });
          }
        } catch (e) {
          // 忽略监听器中的错误
        }
      }
    }
  }

  removeEventListener(type, listener) {
    if (type === 'abort') {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    }
  }

  dispatchEvent(event) {
    if (event.type === 'abort') {
      this.abort();
    }
  }
}