/* Reusable feedback for Super Admin pages. No Bootstrap or data client required. */
(function () {
    'use strict';

    let overlay;
    let dialog;
    let titleNode;
    let messageNode;
    let iconNode;
    let confirmButton;
    let cancelButton;
    let toastContainer;
    let finishDialog = null;
    let previousFocus = null;

    const labels = {
        success: { icon: '✓', title: 'Success' },
        error: { icon: '×', title: 'Something went wrong' },
        warning: { icon: '!', title: 'Attention needed' },
        info: { icon: 'i', title: 'Notice' },
        danger: { icon: '!', title: 'Please confirm' }
    };

    function initialize() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.id = 'app-feedback-modal';
        overlay.className = 'app-feedback-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="app-feedback-dialog" role="dialog" aria-modal="true"
                 aria-labelledby="app-feedback-title" aria-describedby="app-feedback-message" tabindex="-1">
                <span class="app-feedback-icon" aria-hidden="true"></span>
                <h2 id="app-feedback-title"></h2>
                <p id="app-feedback-message"></p>
                <div class="app-feedback-actions">
                    <button type="button" class="app-feedback-cancel">Cancel</button>
                    <button type="button" class="app-feedback-confirm">OK</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        dialog = overlay.querySelector('.app-feedback-dialog');
        titleNode = overlay.querySelector('#app-feedback-title');
        messageNode = overlay.querySelector('#app-feedback-message');
        iconNode = overlay.querySelector('.app-feedback-icon');
        confirmButton = overlay.querySelector('.app-feedback-confirm');
        cancelButton = overlay.querySelector('.app-feedback-cancel');

        toastContainer = document.createElement('div');
        toastContainer.id = 'app-toast-container';
        toastContainer.className = 'app-toast-container';
        toastContainer.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastContainer);

        confirmButton.addEventListener('click', () => closeDialog(true));
        cancelButton.addEventListener('click', () => closeDialog(false));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeDialog(false);
        });
        document.addEventListener('keydown', event => {
            if (overlay.hidden) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closeDialog(false);
            } else if (event.key === 'Tab') {
                const first = cancelButton.hidden ? confirmButton : cancelButton;
                const last = confirmButton;
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });

        document.addEventListener('input', event => {
            if (event.target.matches('.app-field-invalid')) clearFieldError(event.target);
        });
    }

    function closeDialog(confirmed) {
        if (!finishDialog) return;
        const resolve = finishDialog;
        finishDialog = null;
        overlay.hidden = true;
        overlay.classList.remove('is-open');
        if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
        previousFocus = null;
        resolve(confirmed);
    }

    function showDialog(options) {
        initialize();
        if (finishDialog) return Promise.resolve(false);

        const type = labels[options.type] ? options.type : 'info';
        const confirmation = !!options.confirmation;
        previousFocus = document.activeElement;
        overlay.dataset.type = type;
        dialog.setAttribute('role', confirmation ? 'dialog' : 'alertdialog');
        iconNode.textContent = labels[type].icon;
        titleNode.textContent = options.title || labels[type].title;
        messageNode.textContent = options.message || '';
        cancelButton.hidden = !confirmation;
        cancelButton.textContent = options.cancelText || 'Cancel';
        confirmButton.textContent = options.confirmText || (confirmation ? 'Confirm' : 'OK');
        confirmButton.classList.toggle('is-danger', confirmation && type === 'danger');
        overlay.hidden = false;
        overlay.classList.add('is-open');
        const promise = new Promise(resolve => { finishDialog = resolve; });
        (confirmation ? cancelButton : confirmButton).focus();
        return promise;
    }

    function toast(options) {
        initialize();
        const settings = typeof options === 'string' ? { message: options } : (options || {});
        const type = labels[settings.type] ? settings.type : 'info';
        const item = document.createElement('div');
        item.className = 'app-toast';
        item.dataset.type = type;
        item.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const icon = document.createElement('span');
        icon.className = 'app-toast-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = labels[type].icon;
        const body = document.createElement('div');
        body.className = 'app-toast-body';
        const heading = document.createElement('strong');
        heading.textContent = settings.title || labels[type].title;
        const message = document.createElement('span');
        message.textContent = settings.message || '';
        body.append(heading, message);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'app-toast-close';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = '×';
        item.append(icon, body, close);
        const timer = window.setTimeout(() => item.remove(), settings.duration || 4500);
        close.addEventListener('click', () => { window.clearTimeout(timer); item.remove(); });
        toastContainer.appendChild(item);
        while (toastContainer.children.length > 4) toastContainer.firstElementChild.remove();
        return item;
    }

    function clearFieldError(field) {
        if (!field) return;
        field.classList.remove('app-field-invalid', 'is-invalid');
        const note = field.nextElementSibling;
        if (note?.classList.contains('app-field-feedback')) note.remove();
        field.removeAttribute('aria-invalid');
    }

    function fieldError(field, message) {
        initialize();
        if (!field) return;
        clearFieldError(field);
        field.classList.add('app-field-invalid', 'is-invalid');
        field.setAttribute('aria-invalid', 'true');
        const note = document.createElement('div');
        note.className = 'app-field-feedback';
        note.textContent = message;
        field.insertAdjacentElement('afterend', note);
        field.focus();
    }

    function clearFormErrors(form) {
        form?.querySelectorAll('.app-field-invalid').forEach(clearFieldError);
    }

    window.UIFeedback = Object.freeze({
        toast,
        success: (message, title) => toast({ type: 'success', message, title }),
        error: (message, title) => showDialog({ type: 'error', message, title }),
        warning: (message, title) => showDialog({ type: 'warning', message, title }),
        info: (message, title) => showDialog({ type: 'info', message, title }),
        confirm: options => showDialog({ ...(options || {}), confirmation: true }),
        fieldError,
        clearFormErrors
    });
})();
