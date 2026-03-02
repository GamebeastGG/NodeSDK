import { setConfig, GamebeastOptions } from "./config";

export { MarkersService } from "./markers";
export type { GamebeastOptions };

const Gamebeast = {
  setup(options: GamebeastOptions): void {
    setConfig(options);
  },
};

export default Gamebeast;
