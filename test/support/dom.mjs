import assert from "node:assert/strict";

function friendPageWith(entries) {
  class Element {
    constructor(tagName) {
      this.attributes = new Map();
      this.beforeNodes = [];
      this.children = [];
      this.dataset = {};
      this.tagName = tagName;
      this.textContent = "";
    }

    addEventListener(type, handler) {
      this.listeners ??= new Map();
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    click() {
      this.dispatchEvent({ type: "click" });
    }

    dispatchEvent(event) {
      event.target ??= this;
      event.preventDefault ??= () => {
        event.defaultPrevented = true;
      };
      for (const handler of this.listeners?.get(event.type) || []) {
        handler.call(this, event);
      }
      return !event.defaultPrevented;
    }

    focus() {
      const previous = this.ownerDocument?.activeElement;
      if (previous === this) return;
      this.ownerDocument.activeElement = this;
      previous?.dispatchEvent({ type: "focusout", relatedTarget: this });
      previous?.dispatchEvent({ type: "blur", relatedTarget: this });
      this.dispatchEvent({ type: "focus", relatedTarget: previous });
    }

    blur() {
      if (this.ownerDocument?.activeElement !== this) return;
      this.ownerDocument.activeElement = null;
      this.dispatchEvent({ type: "focusout", relatedTarget: null });
      this.dispatchEvent({ type: "blur", relatedTarget: null });
    }

    append(...children) {
      for (const child of children) {
        if (child && this.children.includes(child)) {
          this.children.splice(this.children.indexOf(child), 1);
        }
        if (child && typeof child === "object") {
          child.parentElement = this;
          child.ownerDocument ??= this.ownerDocument;
        }
        this.children.push(child);
      }
    }

    contains(target) {
      return (
        this === target ||
        this.children.some((child) => child?.contains?.(target))
      );
    }

    before(...nodes) {
      this.beforeNodes.push(...nodes);
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  }

  const list = new Element("ul");
  list.children = entries.map(({ href, name }) => {
    const anchor = new Element("a");
    anchor.setAttribute("href", href);
    anchor.textContent = name;
    const strong = new Element("strong");
    strong.append(anchor);
    const container = new Element("div");
    container.className = "userContainer";
    container.append(strong);
    const item = new Element("li");
    item.textContent = name;
    // 浏览器可见性语义的模拟（ADR 0002）：内联 display:none 即不可见。
    item.style = { display: "" };
    item.checkVisibility = function () {
      return this.style.display !== "none";
    };
    item.querySelector = (selector) => {
      if (selector === 'a.avatar[href*="/user/"]') return anchor;
      if (selector === ".userContainer strong") return strong;
      assert.fail(`unexpected selector: ${selector}`);
    };
    return item;
  });

  const document = {
    activeElement: null,
    createElement: (tagName) => {
      const element = new Element(tagName);
      element.ownerDocument = document;
      return element;
    },
    head: new Element("head"),
    querySelector(selector) {
      assert.equal(selector, "#memberUserList");
      return list;
    },
  };
  document.head.ownerDocument = document;
  return { document, list };
}

export { friendPageWith };
