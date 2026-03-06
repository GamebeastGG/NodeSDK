import { setConfig, GamebeastOptions } from "./config";
import markersService from "./markers";
import configsService from "./configs";

const SERVICES : { [key: string]: any } = {
    markers : markersService,
    configs : configsService
}

export const markers = markersService.api;
export const configs = configsService.api;

export type { GamebeastOptions };

function startServices() {
    for (const serviceName in SERVICES) {
        SERVICES[serviceName].setup();
    }
}

const Gamebeast = {
  setup(options: GamebeastOptions): void {
    setConfig(options);
    startServices();
  },
  getConfig: configsService.api.getConfig
};

export default Gamebeast;
