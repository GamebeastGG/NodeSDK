import { makeRequest } from "../requester";
import { EventEmitter } from 'events';

let currentConfigs = {};
let configResolve;
let configReadyPromise = new Promise((resolve) => {
    configResolve = resolve;
});
let configsLoaded = false;

let listeningPaths : Record<string, { parts: string[], emitter: EventEmitter }> = {};

// Functions

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

// Internal Exports

export function updateConfigs(newConfigs : object) {
    const changeTree : Record<string, any> = {};
    const paths = Object.values(listeningPaths);

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

    paths.sort((a, b) => b.parts.length - a.parts.length);

    for (const { parts, emitter } of paths) {
        const oldValue = get(parts);
        const newValue = parts.reduce((obj, part) => obj?.[part as keyof typeof obj], newConfigs);

        const changedInTree = checkPathInChangeTree(parts);

        if (changedInTree || !checkObjectEquality(oldValue, newValue)) {
            emitter.emit("changed", newValue, oldValue);
            
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
        
    currentConfigs = newConfigs;
}

// Public API Methods
function get<config>(path : string | string[]) : config | undefined {
    if (!configsLoaded) {
        throw new Error("Configs not loaded yet. Call onReady() and wait for the promise to resolve before calling get().");
    }

    const parts = normalizePath(path);

    let currentNode: any = currentConfigs;
    for (const part of parts) {
        if (currentNode[part]) {
            currentNode = currentNode[part];
        } else {
            return undefined;
        }
    }

    return currentNode as config;
}

const isReady = () => configsLoaded;

const onReady = (callback : () => void) => configReadyPromise.then(callback);

const onChanged = (path : string | string[], callback : (newValue : any, oldValue : any) => void) : (() => void) => {
    const normalizedPath = normalizePath(path);

    const pathString = normalizedPath.join(".");


    if (!listeningPaths[pathString]) {
        listeningPaths[pathString] = {
            parts : normalizedPath,
            emitter : new EventEmitter(),
        };
    }

    listeningPaths[pathString].emitter.on("changed", callback);

    return () => {
        listeningPaths[pathString].emitter.off("changed", callback);
        listeningPaths[pathString].emitter.listenerCount("changed") === 0 && delete listeningPaths[pathString];
    };
}

const observe = (path : string | string[], callback : (newValue : any, oldValue : any) => void) => {
    if (configsLoaded) {
        setImmediate(() => callback(get(path), undefined));
    }



    return onChanged(path, callback);
}

// Primary Export
export default {
    api : {
        get,
        isReady,
        onReady,
        onChanged
    },
    setup : async function() {
        console.log(await makeRequest("v1/configurations", {}))
    }
}