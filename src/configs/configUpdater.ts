import { EventEmitter } from "events";
import { getSdkConfig } from "../config";
import { makeRequest } from "../requester";

type ConfigEntry = {
    configHash : string,
    configData : object,
    fetched : boolean,
    lastUpdated : number,
    experiments : {
        [key: string]: {
            id : string,
            groups : {
                [key: string]: {
                    name : string,
                    fetched : boolean,
                    config : object,
                }
            }
        }
    }
}

const configCache : { [key: string]: ConfigEntry } = {};

const experimentUpdateEvent = new EventEmitter();
const currentlyFetchingCache : Record<string, Promise<any> | undefined> = {}; 

let colIds : string[] = [];
let runningAssignmentFetch : Promise<any[]> | null = null;

export async function fetchConfig(configName : string, identifier? : string) {
    if (configCache[configName]) {
        if (Object.keys(configCache[configName].experiments).length === 0) {
            return Promise.resolve({
                status : 200,
                ok : true,
                data : {
                    configuration : configCache[configName].configData,
                    experiment : null
                }
            });
        } else if (identifier) {
            if (!runningAssignmentFetch) {
                colIds = [identifier];
                runningAssignmentFetch = new Promise<any[]>((resolve, reject) => {
                    setImmediate(() => {
                        // DO the fetch

                        runningAssignmentFetch = null;
                        const colIdsToFetch = [...colIds];
                        colIds = [];
                        makeRequest<any>("v2/experiments/assignment", {
                            configName,
                            id : colIdsToFetch
                        }).then(res => {
                            console.log("Fetched experiment assignment data:", res);
                            if (res.ok) {                                
                                resolve(res.data)
                            } else {
                                throw new Error(`Failed to fetch experiment assignment data for config ${configName}`);
                            }
                        }).catch(e => {
                            console.error("Failed to fetch experiment assignment data...", e);
                            reject(e);
                        });
                    });
                });
            } else {
                if (!colIds.includes(identifier)) {
                    colIds.push(identifier);
                }
            }

            const assignmentData = await runningAssignmentFetch;
            const assignedExperiment = assignmentData.find((exp : any) => exp.id === identifier);
            
            if (assignedExperiment?.experimentId) {
                const cachedExperiment = configCache[configName].experiments[assignedExperiment.experimentId];
                if (cachedExperiment && cachedExperiment.groups[assignedExperiment.group]?.fetched) {
                    return Promise.resolve({
                        status : 200,
                        ok : true,
                        data : {
                            configuration : cachedExperiment.groups[assignedExperiment.group].config,
                            experiment : {
                                id : assignedExperiment.experimentId,
                                group : assignedExperiment.group
                            }
                        }
                    });
                }
            } else {
                return Promise.resolve({
                    status : 200,
                    ok : true,
                    data : {
                        configuration : configCache[configName].configData,
                        experiment : null
                    }
                });
            }
        }
    } 

    const fetchCacheKey = `${configName}_${identifier || ""}`;
    if (currentlyFetchingCache[fetchCacheKey]) {
        return currentlyFetchingCache[fetchCacheKey];
    }

    // No cache, fetch from server
    const request = makeRequest<any>(`v2/configs/${configName}`, {
        distinctId : identifier
    })

    currentlyFetchingCache[fetchCacheKey] = request;
    
    request.then(configRes => {
        console.log("Fetched config data:", configRes);

        if (configRes.ok) {
            const targetConfigEntry = configCache[configName];
            if (targetConfigEntry) {
                const configData = configRes.data;

                if (configData.experiment) {
                    let targetExperiment = targetConfigEntry.experiments[configData.experiment.id]; //Perhaps we should not ack unknown experiments and let the loop handle it.

                    // todo: Add experiment function to trigger an update.
                    if (!targetExperiment) {
                        targetConfigEntry.experiments[configData.experiment.id] = {
                            id : configData.experiment.id,
                            groups : {}
                        }

                        targetExperiment = targetConfigEntry.experiments[configData.experiment.id];

                        // Found new experiment, emit event so that configs can check if they are affected.
                        experimentUpdateEvent.emit("experimentsChanged", configData.name, Object.keys(targetConfigEntry.experiments));
                    }

                    let targetGroup = targetExperiment.groups[configData.experiment.group];
                    if (!targetGroup) {
                        targetExperiment.groups[configData.experiment.group] = {
                            name : configData.experiment.group,
                            fetched : true,
                            config : {}
                        }

                        targetGroup = targetExperiment.groups[configData.experiment.group];
                    }

                    targetGroup.config = configData.configuration;
                    targetGroup.fetched = true;
                } else {
                    // Default config fetch


                    targetConfigEntry.configData = configData.configuration;
                    targetConfigEntry.fetched = true;
                    targetConfigEntry.lastUpdated = Date.now();
                }
            }
        }
    }).finally(() => {
        delete currentlyFetchingCache[fetchCacheKey];
    });

    return request;
}

export function onExperimentsChanged(configName : string, callback : (experimentId : string[]) => void) : () => void {
    const handler = (changedConfigName : string, experimentId : string[]) => {
        if (changedConfigName === configName) {
            callback(experimentId);
        }
    };

    experimentUpdateEvent.on("experimentsChanged", handler);

    return () => {
        experimentUpdateEvent.off("experimentsChanged", handler);
    }
}

export function onConfigChanged(configName : string, callback : () => void) : () => void {
    const handler = (changedConfigName : string) => {
        if (changedConfigName === configName) {
            callback();
        }
    };

    experimentUpdateEvent.on("configChanged", handler);

    return () => {
        experimentUpdateEvent.off("configChanged", handler);
    }
}


export function startConfigUpdater(refetchIterval: number = 5000)
{
    setInterval(() => {
        console.log("Checking for config updates...");
        makeRequest<{ configurations : any}>("v2/status", {}).then((res) => {
            const updatedConfigs : any[] = res.data.configurations;
            console.log("Updated configs:", updatedConfigs);


            for (const configData of updatedConfigs) {

                let targetConfigEntry = configCache[configData.name];
                if (!targetConfigEntry) {
                    configCache[configData.name] = {
                        configHash : configData.hash,
                        fetched : false,
                        configData : {},
                        lastUpdated : Date.now(),
                        experiments : Object.fromEntries(configData.experiments.map((exp : any) => [
                            exp.id,
                            {
                                id : exp.id,
                                groups : Object.fromEntries(exp.groups.map((group : any) => [
                                    group.name,
                                    { name : group.name, fetched : false, config : {} }
                                ]))
                            }
                        ]))
                    };

                    targetConfigEntry = configCache[configData.name];
                } else {
                    if (targetConfigEntry.configHash !== configData.hash) {
                        console.log(`Config ${configData.name} has been updated. Refetching...`);
                        //fetchConfig(configData.name);
                        // We probably dont need to refetch here. Hash change is enough to trigger the objects to all refetch
                        experimentUpdateEvent.emit("configChanged", configData.name);
                    }
                }

                // Check for experiment updates.

                const removedExperimentIds = Object.keys(targetConfigEntry.experiments).filter(expId => !configData.experiments.some((exp : any) => exp.id === expId));
                for (const expId of removedExperimentIds) {
                    console.log(`Experiment ${expId} has been removed from config ${configData.name}. Removing from cache...`);
                    delete targetConfigEntry.experiments[expId];
                }

                const addedExperiments = configData.experiments.filter((exp : any) => !targetConfigEntry.experiments[exp.id]);
                for (const exp of addedExperiments) {
                    console.log(`Experiment ${exp.id} has been added to config ${configData.name}. Adding to cache...`);
                    targetConfigEntry.experiments[exp.id] = {
                        id : exp.id,
                        groups : Object.fromEntries(exp.groups.map((group : any) => [
                            group.name,
                            { name : group.name, fetched : false, config : {} }
                        ]))
                    };                    
                }

                experimentUpdateEvent.emit("experimentsChanged", configData.name, configData.experiments.map((exp : any) => exp.id));
            }
        }).catch(e => {
            console.error("Failed to check for config updates...", e);
        });

    }, refetchIterval);
}