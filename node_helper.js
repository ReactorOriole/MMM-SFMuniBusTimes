const NodeHelper = require("node_helper");
const fetch = require("node-fetch");
const { parseStringPromise } = require("xml2js");
const { URL } = require("url");

module.exports = NodeHelper.create({
  start: function() {
    console.log(this.name + " has started!");
  },

  url: new URL("https://retro.umoiq.com/service/publicXMLFeed"),

  // Fetch train times and generate a clean object only containing the require data
  loadTimes: async function() {
    let parsedXML;
    try {
      const response = await fetch(this.url);
      const result = await response.text();
      parsedXML = await parseStringPromise(result);
    } catch(err) {
      console.error(err);
      return;
    }

    const obj = parsedXML;

    if (obj.body.Error !== undefined) {
      console.log(obj.body.Error[0]._); // Print out error
      return;
    }
    const { predictions } = obj.body;
    const schedule = [];
    const seenStops = {};

    // Digest data from each stop's predictions
    for (const pred of predictions) {
      let route = pred.$.routeTag;
      if (pred.direction) {
        route = route + '-' + pred.direction[0].$.title;
      }
      const stop = pred.$.stopTitle;
      let stopData;
      // If a stop has been seen before, update the previously created object
      if (seenStops[stop] !== undefined) {
        stopData = seenStops[stop];
      }
      // If not, create a new object
      else {
        stopData = {
          stop,
          routes: [],
          messages: [],
        };
        // TODO: Prevent message repetition in resulting object
        // Sanitize message objects and add them to stop data
        for (const msg of pred.message) {
          const message = msg.$.text;
          stopData.messages.push(message);
        }
      }
      stopData.routes.push({ route, trains: [] });
      const { trains } = stopData.routes[stopData.routes.length - 1];

      let count = 0;
      // Digest data from each train's prediction for a stop
      if (pred.direction) {
        for (const trainPred of pred.direction[0].prediction) {
          count += 1;
          const train = {
            seconds: trainPred.$.seconds,
            delayed: trainPred.$.delayed === true, // Defaults to false if delayed property doesn't exist
            direction: pred.direction[0].$.title,
          };
          trains.push(train);
          // Only process the next 3 trains for the current route
          if (count >= 3) {
            break;
          }
        }
      }
      // Sort routes so they're always ascending alphabetically/numerically
      stopData.routes.sort((a, b) => {
        let aSum = 0,
          bSum = 0;

        // Get the sum of ASCII codes for the first 3 chars of each route names for better accuracy in comparison
        for (let i = 0; i < Math.min(a.route.length, 3); i += 1) {
          aSum += a.route.charCodeAt(i);
        }
        for (let i = 0; i < Math.min(b.route.length, 3); i += 1) {
          bSum += b.route.charCodeAt(i);
        }

        return aSum - bSum;
      });

      if (seenStops[stop] === undefined) {
        schedule.push(stopData);
      }
      seenStops[stop] = stopData;
    }

    // Sort stops in schedule so they're always ascending alphabetically
    schedule.sort((a, b) => {
      let aSum = 0,
        bSum = 0;

      // Get the sum of ASCII codes for the first 4 chars of stop names for better accuracy in comparison
      for (let i = 0; i < Math.min(a.stop.length, 4); i += 1) {
        aSum += a.stop.charCodeAt(i);
      }
      for (let i = 0; i < Math.min(b.stop.length, 4); i += 1) {
        bSum += b.stop.charCodeAt(i);
      }

      return aSum - bSum;
    });

    // Send the schedule to MMM-SFMuniBusTimes
    this.sendSocketNotification("MUNI_TIMINGS", schedule);
  },

  // Build the URL based on the default / user configuration
  buildUrl: function(config) {
    const params = [];
    for (let stop in config.stops) {
      for (let route of config.stops[stop]) {
        params.push(`${route}|${stop}`);
      }
    }

    // Set url params based on config
    this.url.searchParams.append("command", "predictionsForMultiStops");
    this.url.searchParams.append("a", "sfmuni-sandbox");
    for (let param of params) {
      this.url.searchParams.append("stops", param);
    }
  },

  // Handle messages from MMM-SFMuniBusTimes.js
  socketNotificationReceived: function(notification, payload) {
    // If start message is received, build the URL based on the config file, and get schedule
    if (notification === "START") {
      const config = payload;
      this.buildUrl(config);
      this.task = setInterval(this.loadTimes.bind(this), config.updateInterval);
    }
    // If stop timer message is received, stop timer that updates schedule
    if (notification === "STOP_TIMER") {
      clearInterval(this.task);
    }
    // If restart timer message is received, stop current timer (if exists) and start a new one that updates schedule
    if (notification === "RESTART_TIMER") {
      clearInterval(this.task);
      this.task = setInterval(this.loadTimes(), config.updateInterval);
    }
  },
});
