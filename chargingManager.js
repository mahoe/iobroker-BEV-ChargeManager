/*
Copyright 2021 matthias.hoepfner@hoepfnersoftware.de

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

var counter, loading_active, current_charge_amps, interval, current_power,
    power_available, debug_output_counter, new_charge_amps,
    old_charge_power, charge_on_hold, start_load_manager,
    loading_complete,startup_turns, step_down_power_calculated,
    DEFAULT_STARTUP_MILLIS, POLL_INTERVAL,
    MIN_CURRENT_POWER, MIN_POWER_AVAILABLE,
    LOAD_POWER_UP, LOAD_POWER_DOWN,
    TESLA_DATAPOINT_PREFIX,
    DATA_POINT_INVERTER_ACTIVE_POWER, DATA_POINT_METER_ACTIVE_POWER,
    DATA_POINT_TESLA_CHARGE_AMPS, DATA_POINT_TESLA_CHARGE_CABEL,
    CONTROL_TESLA_CHARGE_START, CONTROL_TESLA_CHARGE_STOP,
    DATA_POINT_TESLA_CHARGING_STATE, FRITZBOX_TESLA_WLAN_ACTIVE,
    MAX_CHARGE_AMPS, MIN_CHARGE_AMPS, KEEP_MINIMUM_AMPS,
    CONTROL_TESLA_CHARGE_AMPS;

/** Simply choose a "profile" you like by uncommenting one of the next blocks! */
/* normal charging without import */
/*
MIN_CURRENT_POWER = 3150;           // the power coming from your generator
MIN_POWER_AVAILABLE = 2750;         // the power left or the power you spend into the public network 
LOAD_POWER_UP = 1350;               // step up the current if possible
LOAD_POWER_DOWN = 350;              // step down the current
*/

/* riding on the edge */ 
MIN_CURRENT_POWER = 2750;
MIN_POWER_AVAILABLE = 2450;
LOAD_POWER_UP = 800;
LOAD_POWER_DOWN = 0;
// 0 - stop charging; >=3 keep it charging even the available power is less than zero
KEEP_MINIMUM_AMPS = 0;
/** END of "profiles" */

MIN_CHARGE_AMPS = 3;
MAX_CHARGE_AMPS = 16;
POLL_INTERVAL = 3000;
DEFAULT_STARTUP_MILLIS = 20000;

/** THIS IS TO BE CHANGED BY YOU:
 * Please figure out your datapoints and paste your specific ones into the right fields.
 * -------------------------------------------------------------------------------------
 */
TESLA_DATAPOINT_PREFIX = "tesla-motors.[to be changed by you]";      // this is the first part of your object path. Have a look into iobroker/objects and search for tesla.

/* the power from the generator */
DATA_POINT_INVERTER_ACTIVE_POWER = "0_userdata.0.Huawei.Inverter.Active_Power";

/* the import/export power read from the power meter */
DATA_POINT_METER_ACTIVE_POWER = "0_userdata.0.Huawei.Meter.Active_Power";

DATA_POINT_TESLA_CHARGE_AMPS = TESLA_DATAPOINT_PREFIX + ".remote.set_charging_amps-charging_amps";
DATA_POINT_TESLA_CHARGE_CABEL = TESLA_DATAPOINT_PREFIX + ".charge_state.conn_charge_cable";
DATA_POINT_TESLA_CHARGING_STATE = TESLA_DATAPOINT_PREFIX + ".charge_state.charging_state";

CONTROL_TESLA_CHARGE_START = TESLA_DATAPOINT_PREFIX + ".remote.charge_start";
CONTROL_TESLA_CHARGE_STOP = TESLA_DATAPOINT_PREFIX + ".remote.charge_stop";
CONTROL_TESLA_CHARGE_AMPS = TESLA_DATAPOINT_PREFIX + ".remote.set_charging_amps-charging_amps";  // yes - it's the same :-)

// to check if the tesla is present in the local wifi
FRITZBOX_TESLA_WLAN_ACTIVE = "fb-checkpresence.0.fb-devices.Tesla-Model-3.active";               

    /**
 * -------------------------------------------------------------------------------------
 * END OF "THIS IS TO BE CHANGED BY YOU"
 */

start_load_manager = true;
loading_active = false;    
counter = 0;

/** enable the load manager at sunrise */
schedule({astro: "sunriseEnd", shift: 0}, async function () {
    start_load_manager = true;
    console.log("Good morning!");
});

/** disable the load manager at sunset */
schedule({astro: "sunset", shift: 0}, async function () {
    start_load_manager = false;
    console.log("I'll go to sleep now.");
});

schedule("*/2 * * * *", runEveryTwoMinutes);

function runEveryTwoMinutes() {
  if(loading_active || !start_load_manager) {
      //if( counter++ % 5 == 0){
          console.log("runEveryTwoMinutes - loading_active: "+ loading_active + "; start_load_manager: " + start_load_manager);
      //}
      return;
  }
  checkToStartCharging();
};

/** in case the car is active in the local WiFi start the manager routine */
on({id: FRITZBOX_TESLA_WLAN_ACTIVE, val: true}, async function (obj) {
  if(loading_active || !start_load_manager) {
      return;
  }
  checkToStartCharging();
});

/** in case the car is NOT active in the local WiFi... */
on({id: FRITZBOX_TESLA_WLAN_ACTIVE, val: false}, async function (obj) {
  loading_active = false;
});

function checkToStartCharging() {
    if(checkIfCarIsPresent() && checkCableIsIEC(true)) {
        tryToStartCharging();
    }
}

function checkIfCarIsPresent() {
    return getState(FRITZBOX_TESLA_WLAN_ACTIVE).val;
}

function checkCableIsIEC(log_output) {
    var cableType = getState( DATA_POINT_TESLA_CHARGE_CABEL).val;
    if(log_output){
        console.log('Cable type connected to car: ' + cableType);
    }
    
    return 'IEC' == cableType;
}

function checkCancelCharging(log_output) {
    if(!loading_active) {
        console.log("charging is not active.");
        return true;
    }

    if(!checkCableIsIEC(log_output)) {
        console.log("cable is not connected to wallbox.");
        loading_active = false;
        return true;
    }
    return false;
}

async function tryToStartCharging() {
    console.log('lets try to start charging');
    if (getState( DATA_POINT_TESLA_CHARGING_STATE).val != 'Complete') {
        console.log('There is some space in the battery to fill.');
        if (!loading_active) {
          loading_active = true;
          await startLoading();
        } else {
          console.log('Already loading!');
        }
      } else {
        console.log('Battery is fully charged!');
      }
}

/**
 * Start loading the Tesla and continuously change the power to reflect the available power.
 */
async function startLoading() {
  console.log('Loading manager starts here');

  new_charge_amps = 0;
  old_charge_power = 0;
  debug_output_counter = 0;
  charge_on_hold = true; // true means loading is paused at the moment
  startup_turns = 0;

  interval = setInterval(async function () {
      if(checkCancelCharging(false)){
          if (interval) {
              clearInterval(interval);
              interval = null;
            }
          return;
      }
    current_power = getState(DATA_POINT_INVERTER_ACTIVE_POWER).val;
    power_available = getState(DATA_POINT_METER_ACTIVE_POWER).val;

    console.log('Excess power: ' + power_available + ( charge_on_hold ? " - wait for start charging" : " - charging..."));
    if (!charge_on_hold || (current_power > MIN_CURRENT_POWER && power_available > MIN_POWER_AVAILABLE)) {

        console.debug("check charger power setting");
        current_charge_amps = getState(DATA_POINT_TESLA_CHARGE_AMPS).val;
        console.log( "current AMPS " + current_charge_amps );

      if (current_charge_amps == 0 || getState( DATA_POINT_TESLA_CHARGING_STATE).val != "Charging") {
        console.log('Try to start charging.');
        getState(CONTROL_TESLA_CHARGE_START, function (err, state) {
            setStateDelayed(CONTROL_TESLA_CHARGE_START, state ? !state.val : true, 1000, false);
            charge_on_hold = false;
            console.log('Charging started.');
        });
      }

      if (current_charge_amps < MAX_CHARGE_AMPS && power_available > LOAD_POWER_UP && startup_turns-- <= 0) {
        console.log('Raise charging amps');
        step_down_power_calculated = LOAD_POWER_DOWN < 0 ? 0 : LOAD_POWER_DOWN;
        var diff_apms = Math.round((power_available - step_down_power_calculated - 350) / 1000 / 0.8);
        new_charge_amps = current_charge_amps + diff_apms <= MAX_CHARGE_AMPS ? current_charge_amps + diff_apms : MAX_CHARGE_AMPS;

        // wenn die Differenz zu gross ist, dann warte erst einmal ab, bis die Ladeleistung auch wirklich gezogen wird.
        startup_turns = diff_apms > 3 ? Math.ceil( DEFAULT_STARTUP_MILLIS / POLL_INTERVAL) : 0;

      } else if (power_available < LOAD_POWER_DOWN) {
        console.log('Reduce charging amps');
        if(power_available<0){
            var over_amps = Math.abs(Math.round((power_available - LOAD_POWER_DOWN - 350) / 1000 / 0.68));
            console.log('amps need to be reduces by: ' + over_amps);
            new_charge_amps = current_charge_amps - over_amps;
        } else {
            new_charge_amps = current_charge_amps-1;
        }

        new_charge_amps = KEEP_MINIMUM_AMPS != 0 && KEEP_MINIMUM_AMPS > new_charge_amps ? KEEP_MINIMUM_AMPS : new_charge_amps;
      }

      if (new_charge_amps != current_charge_amps) {
        if (!charge_on_hold && new_charge_amps < MIN_CHARGE_AMPS) {
            console.log('Charging paused');
            getState(CONTROL_TESLA_CHARGE_STOP, function (err, state) {
                setStateDelayed(CONTROL_TESLA_CHARGE_STOP, state ? !state.val : true, 1000, false);
                setState(DATA_POINT_TESLA_CHARGE_AMPS, 0);
                charge_on_hold = true;
                new_charge_amps = 0;
            });            
            
        } else {
            if(charge_on_hold){
                console.log('Charging restarted');
                getState(CONTROL_TESLA_CHARGE_START, function (err, state) {
                    setStateDelayed(CONTROL_TESLA_CHARGE_START, state ? !state.val : true, 1000, false);
                    charge_on_hold = false;
                    startup_turns = Math.ceil( DEFAULT_STARTUP_MILLIS / POLL_INTERVAL);
                });                 
            }

            console.log('Set charging current to (amps): ' + new_charge_amps);
            setState(CONTROL_TESLA_CHARGE_AMPS, new_charge_amps);
        }
      }
    } else {
      if (0 == debug_output_counter++ % 10) {
        console.log("Not enough electricity available!");
      }
    }

    loading_complete = getState(DATA_POINT_TESLA_CHARGE_AMPS).val == 'Complete'

    if (loading_complete || !start_load_manager) {
      console.log("Lademanager will be shut down. The charging limit was" + (loading_complete ? "" : "n't") + " reached!");
      loading_active = false;
      (function () {if (interval) {clearInterval(interval); interval = null;}})();
    }
    
  }, POLL_INTERVAL);
}
