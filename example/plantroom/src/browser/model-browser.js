/**
 * Browser Plantroom model — Vite-resolved @domecs/core + shared domain.
 */
import * as core from '@domecs/core'
import {
  buildPlant,
  makeProposal,
  proposalRestartOnly,
  proposalResetAndStart,
} from '../buildPlant.js'

const plant = buildPlant(core)

export const createPlantWorld = plant.createPlantWorld
export const resolveCommand = plant.resolveCommand
export const CommandResult = plant.events.CommandResult
export const Tag = plant.components.Tag
export const Alarm = plant.components.Alarm
export const Pump = plant.components.Pump
export const Vessel = plant.components.Vessel
export const Sensor = plant.components.Sensor
export const PlantState = plant.components.PlantState
export const Historian = plant.components.Historian
export const SetPump = plant.events.SetPump
export const InjectFault = plant.events.InjectFault
export const AcknowledgeAlarm = plant.events.AcknowledgeAlarm
export { makeProposal, proposalRestartOnly, proposalResetAndStart }
