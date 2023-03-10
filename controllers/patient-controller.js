const Patient = require('../models/Patient')
const Therapist = require('../models/Therapist')
const catchAsync = require('../utils/catchAsync')
const { StatusCodes } = require('http-status-codes')
const Session = require('../models/Session')
const factoryController = require('./handlerFactory')
const { BadRequest, InternalServerError } = require('../errors')
const SubscriptionPlan = require('../models/SubscriptionPlan')
const Email = require('../utils/email')
const { getIntersectionCount } = require('../utils/myUtills')
const { twoHours, fifteenMinutes } = require('../utils/date_funcs')

// create a search weight Function
const getTherapistSuitabilty = (therapist, profile) => {
  let suitability = 0

  // specialization has highest weight
  // For each match of problem-to-specialization a weight of 5
  suitability +=
    getIntersectionCount(
      therapist.specialization || [],
      profile.problems || []
    ) * 5

  if (therapist.sexPreference == profile.gender) suitability += 2
  if (therapist.isWithinAgeRange(profile.age)) suitability += 2
  if (therapist.religionPreference == profile.religion) suitability += 2
  if (therapist.statusPreference == profile.status) suitability += 2
  if (therapist.locationPreference.state == profile.state) suitability += 2
  if (therapist.locationPreference.country == profile.country) suitability += 1

  //   consider years of experience and patient rating
  suitability += therapist.years_of_experience + therapist.averageRating

  return suitability
}
//find a therapist based on preference and standard max-activeSession
const fetchTherapist = async (profile, maxActiveSession) => {
  //grab all therapists
  let therapists = await Therapist.find().populate(
    'activeSessions',
    '_id appointments'
  )

  //  filter out unavailable
  therapists = therapists.filter((therapist) => {
    return therapist.activeSessions.length < maxActiveSession
  })

  //sort base on suitabilty with the m
  therapists.sort(
    (a, b) =>
      getTherapistSuitabilty(b, profile) - getTherapistSuitabilty(a, profile)
  )

  // return a max of 10
  if (therapists.length > 10) therapists = therapists.slice(0, 10)

  return therapists.map((th) => ({
    id: th._id,
    _id: th._id,
    name: th.name,
    about: th.about,
    rating: th.averageRating,
    work_experience: `${th.years_of_experience} Years`,
    image: th.image,
    availableTimes: th.availableTimes,
  }))
}

module.exports.getMe = catchAsync(async (req, res, next) => {
  const id = req.user._id
  const patient = await Patient.findById(id)
  res.status(StatusCodes.OK).json({ status: 'success', data: patient })
})

exports.updateMe = factoryController.updateMe(Patient)

module.exports.getTherapy = catchAsync(async (req, res, next) => {
  const profile = req.body.profile || req.body

  //get available therapist
  const potentialTherapists = await fetchTherapist(
    profile,
    process.env.MAXSESSION || 10
  )
  // save request profile to user
  Patient.findByIdAndUpdate(req.user._id, {
    $addToSet: { requestProfiles: profile },
  })
  res.status(StatusCodes.OK).json({
    status: 'success',
    results: potentialTherapists.length,
    data: potentialTherapists,
  })
})

module.exports.getSessions = catchAsync(async (req, res, next) => {
  const id = req.user._id
  const sessions = await Session.find({ patient: id })
    .select('-notes')
    .sort('-expiryDate -createdAt -paymentStatus')

  res.status(
    StatusCodes.OK.json({
      status: 'success',
      result: sessions.length,
      data: sessions,
    })
  )
})

//req.body includes selected therapists id, contract period (subscriptionPlan)
module.exports.selectTherapy = catchAsync(async (req, res, next) => {
  const { therapistID, subscriptionPlan } = req.body
  const therapist = await Therapist.findById(therapistID)
  const subPlan = await SubscriptionPlan.findById(subscriptionPlan)
  if (!therapist || !subPlan) {
    return next(new BadRequest('Invalid therapistID or subscriptionPlan'))
  }

  // Create The Session with paymentStatus pending
  const newSession = await Session.create({
    patient: req.user._id,
    therapist: therapist._id,
    subscriptionPlan: subPlan._id,
    paymentStatus: 'pending',
    paymentRef: '',
  })

  // Send Notification Email
  new Email(req.user, 'https://anonymous-confidant.com')
    .sendReservationNotice(therapist)
    .catch((err) => console.log('Error sending Email >>>', err.message))

  if (!newSession)
    return next(
      new InternalServerError('server error, could not create session')
    )

  return res.status(StatusCodes.CREATED).json({
    status: 'success',
    message: 'session created successfully',
    data: newSession,
  })
})

exports.bookAppointment = catchAsync(async (req, res, next) => {
  const { sessionID } = req.params
  const time = req.body.time || req.body.startTime
  const title = req.body.title || 'Appointment'
  const start_time = new Date(time)
  if (!time || start_time == 'Invalid Date')
    return next(
      new BadRequest('Please provide a valid time for the appointment!')
    )
  // find the right session
  const session = await Session.findOne({
    _id: sessionID,
    patient: req.user._id,
    paymentStatus: 'paid',
    hoursRemaining: { $gt: 0 },
    expiryDate: { $gt: Date.now() },
  })
  if (!session)
    return next(new BadRequest('Invalid session or session expired'))

  // confirm if no overlap in active sessions of therapist
  const noOverLap = await Session.checkAppointmentOverlap(
    session.therapist,
    start_time
  )
  if (!noOverLap)
    return next(
      new BadRequest('Time is already booked, Please choose a different time')
    )

  // create an appointment and add to session
  await Session.findByIdAndUpdate(session._id, {
    $push: {
      appointments: {
        start_time,
        end_time: new Date(
          start_time.getTime() + twoHours + (fifteenMinutes * 2) / 3
        ),
        status: 'pending',
        title,
      },
    },
    $inc: { hoursRemaining: -2 },
  })

  // send email notification to therapist
  new Email(req.user)
    .sendAppointmentNotification({
      start_time,
      status: 'pending',
    })
    .catch((err) => console.log('Err sending email >>>', err.message))
  res
    .status(StatusCodes.CREATED)
    .json({ status: 'success', message: 'appointment requested' })
})

exports.patientFilter = (req, res, next) => {
  req.filter = { patient: req.user._id }
  req.query.fields = req.query.fields ? `${req.query.fields},-notes` : '-notes'
  req.body.patient = req.user._id
  if (!req.body.authorID) req.body.authorID = req.user._id
  next()
}
exports.getAllPatients = factoryController.getAll(Patient)
exports.getPatient = factoryController.getOne(Patient)
exports.deletePatient = factoryController.deleteOne(Patient)
exports.createPatient = factoryController.createOne(Patient)

// Session.find().then((res)=>{
//   console.log(res)
//   res.map(a=>{
//     Session.findByIdAndDelete(a._id).then(()=>{
//       console.log("deleted")
//     })
//   })
// }).catch(err =>{
//   console.log(err)
// })

// Therapist.create({
//   name:"tester",
//   email:"horlarhyinkaddev@dev.co",
//   password:"testaroo"
// }).then(res=>{console.log(res)}).catch((ex)=>{console.log(ex)})

// Session.find().then(res=>{
//   console.log(res)
// })
// Session.create({
//   therapist:"63121c1f581e4a76a12fa110",
//   patient:"631223cdca8f99e436091a80"
// }).then(res=>{console.log(res)})
//therapistID  6313099537dac36cff12f9d7
//patientID  631223cdca8f99e436091a80
//sessionID  63122520703e507d617ec6a5
