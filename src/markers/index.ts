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

var runningTimeout : undefined | number;
let MarkerCache: MarkerPayload[] = [];

function flushMarkers() {
  if (MarkerCache.length === 0) {
    return;
  }

  const markersToFlush = [...MarkerCache];
  MarkerCache.length = 0;


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
    

  MarkerCache = [];
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

  MarkerCache.push(marker);
  if (MarkerCache.length >= getConfig().markerFlushSize!) {
    flushMarkers();
  }

  if (runningTimeout) {
    clearTimeout(runningTimeout);
  }

  runningTimeout = setTimeout(() => {
    flushMarkers();
  }, 5000);

}

export const MarkersService = {
  sendMarker(markerName: string, markerValue : any): void {
    createMarker(markerName, markerValue);
  },

  sendUserMarker(userId : string, markerName : string, markerValue : any) : void {
    createMarker(markerName, markerValue, userId);
  }
};
