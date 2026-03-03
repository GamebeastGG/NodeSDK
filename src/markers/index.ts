import { getConfig } from "../config";
import { makeRequest } from "../requester";

type MarkerPayload = {
  markerId : string,
  timestamp : number,
  eventName : string,
  serverId : string,
  userId? : string,
  properties : object
}

var runningTimeout: NodeJS.Timeout | null = null;
let markerCache: MarkerPayload[] = [];

function flushMarkers() {
  if (markerCache.length === 0) {
    return;
  }

  const markersToFlush = [...markerCache];
  markerCache.length = 0;


  console.log(JSON.stringify({ markers : markersToFlush }));

  makeRequest("v1/markers", { markers : markersToFlush })
    .then((res) => {
      console.log(`Flushed ${markersToFlush.length} markers.`);
      console.log(res.ok, res.data);
    })
    .catch((e) => {
      console.error("Failed to flush markers...", e);
      // TODO: Implement retry logic here. Potentially we'd want to have a callback for users to handle failed flushes?
    })
    

  markerCache = [];
}

function createMarker(markerName: string, markerValue : any, userId? : string) {

  if (typeof markerValue !== "object") {
    markerValue = { value : markerValue };
  }

  const marker: MarkerPayload = {
    markerId : crypto.randomUUID(),
    timestamp : new Date().getTime(),
    eventName : markerName,
    serverId : "node-0000",
    userId : userId,
    properties : markerValue
  }

  markerCache.push(marker);
  if (markerCache.length >= getConfig().markerFlushSize!) {
    flushMarkers();
  }

  if (runningTimeout) {
    clearTimeout(runningTimeout);
  }

  runningTimeout = setTimeout(() => {
    flushMarkers();
  }, 5000);

}


export default {
  api : {
    sendMarker(markerName: string, markerValue : any): void {
      createMarker(markerName, markerValue);
    },

    sendUserMarker(userId : string, markerName : string, markerValue : any) : void {
      createMarker(markerName, markerValue, userId);
    }
  },
  setup : function() {
    //
  }
};
