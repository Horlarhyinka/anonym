const mongoose = require('mongoose')

const subsPlanSchema = mongoose.Schema({
  duration: {
    // duration in hours
    type: Number,
    required: [true, 'Please provide the duration of the plan'],
    default: 1,
  },
  title: {
    // Name of the Plan
    type: String,
    unique: [true, 'Plan already exist'],
    required: [true, 'Please provide The title of the plan'],
  },
  price: {
    // in dollars
    type: Number,
    required: [true, 'Please provide the Price'],
  },
  discount: {
    type: Number,
    default: 0,
  },
})

const SubscriptionPlan = mongoose.model('SubscriptionPlan', subsPlanSchema)
module.exports = SubscriptionPlan
