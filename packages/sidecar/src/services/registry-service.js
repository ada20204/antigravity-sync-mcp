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
        fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), 'utf-8');
        try {
            fs.chmodSync(registryFile, 0o600);
        } catch { }
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
