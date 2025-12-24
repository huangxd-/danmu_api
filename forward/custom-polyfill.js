// 本插件从项目 https://github.com/huangxd-/danmu_api.git 一键导出，配置参数使用说明请参考该项目README

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

const { setTimeout: customSetTimeout, clearTimeout: customClearTimeout } = (function() {
  let timerId = 0;
  const timers = new Map();

  const setTimeoutFn = function(callback, delay = 0) {
    const id = ++timerId;
    
    if (typeof Promise !== 'undefined') {
      Promise.resolve().then(() => {
        if (timers.has(id)) {
          try {
            callback();
          } catch (e) {
            console.error('setTimeout error:', e);
          } finally {
            timers.delete(id);
          }
        }
      });
    } else {
      // 同步执行
      try {
        callback();
      } catch (e) {
        console.error('setTimeout error:', e);
      }
    }
    
    timers.set(id, { callback, delay, timestamp: Date.now() });
    return id;
  };

  const clearTimeoutFn = function(id) {
    return timers.delete(id);
  };

  return {
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn
  };
})();

const setTimeout = customSetTimeout;
const clearTimeout = customClearTimeout;

class Headers {
  constructor(init = {}) {
    this._headers = {};
    if (init instanceof Headers) {
      // 从另一个Headers实例初始化
      for (const [key, value] of init.entries()) {
        this.set(key, value);
      }
    } else if (Array.isArray(init)) {
      // 从键值对数组初始化
      for (const [key, value] of init) {
        this.set(key, value);
      }
    } else if (init && typeof init === 'object') {
      // 从对象初始化
      for (const [key, value] of Object.entries(init)) {
        this.set(key, value);
      }
    }
  }

  append(name, value) {
    name = name.toLowerCase();
    if (this._headers[name]) {
      this._headers[name] = this._headers[name] + ', ' + value;
    } else {
      this._headers[name] = value;
    }
  }

  delete(name) {
    delete this._headers[name.toLowerCase()];
  }

  get(name) {
    return this._headers[name.toLowerCase()] || null;
  }

  has(name) {
    return name.toLowerCase() in this._headers;
  }

  set(name, value) {
    this._headers[name.toLowerCase()] = String(value);
  }

  forEach(callback, thisArg) {
    for (const [name, value] of Object.entries(this._headers)) {
      callback.call(thisArg, value, name, this);
    }
  }

  *entries() {
    for (const [name, value] of Object.entries(this._headers)) {
      yield [name, value];
    }
  }

  *keys() {
    for (const name of Object.keys(this._headers)) {
      yield name;
    }
  }

  *values() {
    for (const value of Object.values(this._headers)) {
      yield value;
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  toJSON() {
    return { ...this._headers };
  }
}

class Response {
  constructor(body, init = {}) {
    this.status = init.status || 200;
    this.statusText = init.statusText || 'OK';
    this.headers = new Headers(init.headers || {}); 
    this.type = 'default';
    this.url = '';
    this.redirected = false;
    
    this._bodyUsed = false;
    if (body !== undefined && body !== null) {
      this._body = body;
    } else {
      this._body = '';
    }
  }

  get ok() {
    return this.status >= 200 && this.status < 300;
  }

  get bodyUsed() {
    return this._bodyUsed;
  }

  _checkBodyUsed() {
    if (this._bodyUsed) {
      throw new TypeError('body stream already read');
    }
    this._bodyUsed = true;
  }

  async json() {
    this._checkBodyUsed();
    if (typeof this._body === 'string') {
      return JSON.parse(this._body);
    }
    return this._body;
  }

  async text() {
    this._checkBodyUsed();
    if (typeof this._body === 'string') {
      return this._body;
    }
    return String(this._body);
  }

  clone() {
    if (this._bodyUsed) {
      throw new TypeError('cannot clone a disturbed response');
    }
    const cloned = new Response(this._body, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers
    });
    return cloned;
  }
}
