function createRegistryService(params) {
    const {
        fs,
        registryDir,
        registryFile,
        registryControlKey,
        controlNoCdpPromptKey,
    } = params;

    function getDefaultControlRecord() {
        return {
            restart_requests: {},
            [controlNoCdpPromptKey]: {},
        };
    }

    function getControlRecord(registry) {
        if (!registry || typeof registry !== 'object') return getDefaultControlRecord();
        const raw = registry[registryControlKey];
        if (!raw || typeof raw !== 'object') return getDefaultControlRecord();
        const control = raw;
        if (!control.restart_requests || typeof control.restart_requests !== 'object') {
            control.restart_requests = {};
        }
        if (!control[controlNoCdpPromptKey] || typeof control[controlNoCdpPromptKey] !== 'object') {
            control[controlNoCdpPromptKey] = {};
        }
        return control;
    }

    function readRegistryObject() {
        try {
            if (!fs.existsSync(registryFile)) return {};
            const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
            if (parsed && typeof parsed === 'object') return parsed;
        } catch { }
        return {};
    }

    function writeRegistryObject(registry) {
        if (!fs.existsSync(registryDir)) {
            fs.mkdirSync(registryDir, { recursive: true });
        }
        registry[registryControlKey] = getControlRecord(registry);
        // Atomic write: tmp + rename so concurrent readers (the server) never
        // observe a half-written file. chmod the tmp before rename so the final
        // file keeps 0o600 atomically.
        const tmp = `${registryFile}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf-8');
            try { fs.chmodSync(tmp, 0o600); } catch { }
            fs.renameSync(tmp, registryFile);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch { }
            throw e;
        }
    }

    return {
        getControlRecord,
        readRegistryObject,
        writeRegistryObject,
    };
}

module.exports = {
    createRegistryService,
};
