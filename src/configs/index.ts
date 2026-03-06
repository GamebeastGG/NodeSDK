import { makeRequest } from "../requester";
import { EventEmitter } from 'events';
import GamebeastConfig from "./configObject";
import { startConfigUpdater } from "./configUpdater";
import { getSdkConfig } from "../config";

function getConfig(configName : string, settings : {identifier? : string} = {}) {
    return GamebeastConfig.create(configName, settings.identifier);
}

// Primary Export
export default {
    api : {
        getConfig,
    },
    setup : async function() {
        startConfigUpdater();
    }
}