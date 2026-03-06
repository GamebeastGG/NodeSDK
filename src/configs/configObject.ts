import EventEmitter from "events";
import { onExperimentsChanged, onConfigChanged, fetchConfig } from "./configUpdater";


function normalizePath(path : string | string[]) : string[] {
    if (typeof path === "string") {
        return path.split(".");
    }
    return path;
}

function checkObjectEquality(obj1 : any, obj2 : any) : boolean {
    if (typeof obj1 !== typeof obj2) {
        return false;
    }

    if (typeof obj1 !== "object" || obj1 === null || obj2 === null) {
        return obj1 === obj2;
    }

    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length !== keys2.length) {
        return false;
    }

    for (const key of keys1) {
        const val1 = obj1[key as keyof typeof obj1];
        const val2 = obj2[key as keyof typeof obj2];
        
        if (typeof val1 === "object" && typeof val2 === "object") {
            if (!checkObjectEquality(val1, val2)) {
                return false;
            }
        } else if (val1 !== val2) {
            return false;
        }
    }

    return true;
}


class GamebeastConfig {
    private name: string;
    private identifier?: string;
    private data: any = {};
    private experiment : { id : string, group : string } | null = null;
    private experimentListChangedUnsub: () => void;
    private configChangedUnsub: () => void;
    private destroyed = false;
    private listeningPaths: { [key: string]: {activeCount : number, parts : string[]} } = {};

    private internalChangedEvent = new EventEmitter();

    constructor(name: string, identifier?: string)  {
        this.name = name;
        this.identifier = identifier;

        this.experimentListChangedUnsub = onExperimentsChanged(this.name, (experimentIds) => {
            if (this.experiment && !experimentIds.includes(this.experiment.id)) {
                // We've been removed, switch to default config, or new experiment.
                this.fetchAndUpdateConfig(); 
            } else if (!this.experiment && experimentIds.length > 0) {
                // We've been added, refetch
                this.fetchAndUpdateConfig();
            }
        });

        this.configChangedUnsub = onConfigChanged(this.name, () => {
            this.fetchAndUpdateConfig();
        });
        
    }

    static async create(name: string, identifier? : string) {
        const configResponse = await fetchConfig(name, identifier);

        const config = new GamebeastConfig(name, identifier);
        if (configResponse.ok) {
            
            config.data = configResponse.data.configuration;
            config.experiment = configResponse.data.experiment;
        }

        return config;
    }

    private assertAlive() {
        if (this.destroyed) {
            throw new Error(`Config ${this.name} has been destroyed and can no longer be used.`);
        }
    }

    private applyConfig(newConfigData : any, experimentData : { id : string, group : string } | null) {
        const oldConfig = this.data;
        this.data = newConfigData;
        this.experiment = experimentData;

        // Emit change events for any changed keys
        const changeTree : Record<string, any> = {};
        const paths = Object.keys(this.listeningPaths);

        function checkPathInChangeTree(parts : string[]) : boolean {
            let currentNode = changeTree;
            for (const part of parts) {
                if (currentNode[part]) {
                    currentNode = currentNode[part];
                } else {
                    return false;
                }
            }
            return true;
        }

        paths.sort((a, b) => this.listeningPaths[b].parts.length - this.listeningPaths[a].parts.length);

        for (const path of paths) {
            const parts = this.listeningPaths[path].parts;

            const newValue = this.get(parts);
            const oldValue = parts.reduce((obj, part) => obj?.[part as keyof typeof obj], oldConfig);

            const changedInTree = checkPathInChangeTree(parts);

            if (changedInTree || !checkObjectEquality(oldValue, newValue)) {
                this.internalChangedEvent.emit(path, newValue, oldValue);
                
                if (!changedInTree) {
                    let targetLevel = changeTree;
                    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
                        const part = parts[partIndex];

                        targetLevel[part] = targetLevel[part] || {};
                        targetLevel = targetLevel[part];
                    }
                }
            }
        }
    }

    private fetchAndUpdateConfig() {
        fetchConfig(this.name, this.identifier).then(configResponse => {
            if (configResponse.ok) {
                const configData = configResponse.data;

                this.applyConfig(configData.configuration, configData.experiment ? { id : configData.experiment.id, group : configData.experiment.group } : null);
            }
        }).catch(e => {
            //TODO: This would result in config being outdated :(
            console.error(`Failed to fetch config data for config ${this.name} during update.`, e);
        });
    }

    public get<T>(path: string | string[]): T | undefined {
        this.assertAlive();
        
        const parts = normalizePath(path);
        let current: any = this.data;
        for (const part of parts) {
            if (current?.[part] === undefined) return undefined;
            current = current[part];
        }
        return current as T;
    }

    public onChanged(path : string, callback: (newValue: any, oldValue: any) => void): () => void {
        this.assertAlive();

        const handler = (changedPath: string, newValue: any, oldValue: any) => {
            if (changedPath === path) {
                callback(newValue, oldValue);
            }
        }

        this.internalChangedEvent.on(path, handler);

        if (!this.listeningPaths[path]) {
            this.listeningPaths[path] = { activeCount: 0, parts: path.split(".") };
        }
        this.listeningPaths[path].activeCount++;

        return () => {
            this.internalChangedEvent.off(path, handler);
            this.listeningPaths[path].activeCount--;
            if (this.listeningPaths[path].activeCount === 0) {
                delete this.listeningPaths[path];
            }
        };
    }

    public destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        // Clean up any listeners or resources associated with this config instance
        this.experimentListChangedUnsub();
        this.configChangedUnsub();
        this.internalChangedEvent.removeAllListeners();
    }
}

export default GamebeastConfig;
