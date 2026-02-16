import '/backend/backend.dart';
import '/components/side_nav/side_nav_bar/side_nav_bar_widget.dart';
import '/components/top_nav_bar_widget.dart';
import '/flutter_flow/flutter_flow_calendar.dart';
import '/flutter_flow/flutter_flow_radio_button.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/flutter_flow/flutter_flow_widgets.dart';
import '/flutter_flow/form_field_controller.dart';
import '/flutter_flow/custom_functions.dart' as functions;
import '/index.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_spinkit/flutter_spinkit.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'booking_date_selection_model.dart';
export 'booking_date_selection_model.dart';

class BookingDateSelectionWidget extends StatefulWidget {
  const BookingDateSelectionWidget({
    super.key,
    required this.client,
    this.worker,
    required this.service,
    required this.currentReservation,
    this.appointments,
    this.date,
    this.time,
    bool? isFromSecondAgenda,
    this.serviceName,
  }) : this.isFromSecondAgenda = isFromSecondAgenda ?? false;

  final ClientsRecord? client;
  final WorkersRecord? worker;
  final AccomodationServicesRecord? service;
  final int? currentReservation;
  final List<AppointmentsRecord>? appointments;
  final DateTime? date;
  final String? time;
  final bool isFromSecondAgenda;
  final String? serviceName;

  static String routeName = 'Booking_date_selection';
  static String routePath = '/bookingDateSelection';

  @override
  State<BookingDateSelectionWidget> createState() =>
      _BookingDateSelectionWidgetState();
}

class _BookingDateSelectionWidgetState
    extends State<BookingDateSelectionWidget> {
  late BookingDateSelectionModel _model;

  final scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    _model = createModel(context, () => BookingDateSelectionModel());

    // On page load action.
    SchedulerBinding.instance.addPostFrameCallback((_) async {
      _model.appointments =
          widget.appointments!.toList().cast<AppointmentsRecord>();
      safeSetState(() {});
    });

    WidgetsBinding.instance.addPostFrameCallback((_) => safeSetState(() {}));
  }

  @override
  void dispose() {
    _model.dispose();

    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    context.watch<FFAppState>();

    return Title(
        title: 'Booking_date_selection',
        color: FlutterFlowTheme.of(context).primary.withAlpha(0XFF),
        child: GestureDetector(
          onTap: () {
            FocusScope.of(context).unfocus();
            FocusManager.instance.primaryFocus?.unfocus();
          },
          child: Scaffold(
            key: scaffoldKey,
            backgroundColor: FlutterFlowTheme.of(context).primaryBackground,
            body: Row(
              mainAxisSize: MainAxisSize.max,
              children: [
                if (responsiveVisibility(
                  context: context,
                  phone: false,
                  tablet: false,
                ))
                  wrapWithModel(
                    model: _model.sideNavBarModel,
                    updateCallback: () => safeSetState(() {}),
                    child: SideNavBarWidget(),
                  ),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.max,
                    children: [
                      if (responsiveVisibility(
                        context: context,
                        phone: false,
                        tablet: false,
                      ))
                        wrapWithModel(
                          model: _model.topNavBarModel,
                          updateCallback: () => safeSetState(() {}),
                          child: TopNavBarWidget(
                            currentItem: 'spa_management',
                          ),
                        ),
                      Expanded(
                        child: Stack(
                          children: [
                            Container(
                              width: MediaQuery.sizeOf(context).width * 1.0,
                              height: MediaQuery.sizeOf(context).height * 1.0,
                              decoration: BoxDecoration(
                                color: FlutterFlowTheme.of(context)
                                    .secondaryBackground,
                              ),
                              child: Column(
                                mainAxisSize: MainAxisSize.max,
                                children: [
                                  Container(
                                    width:
                                        MediaQuery.sizeOf(context).width * 1.0,
                                    height: 100.0,
                                    decoration: BoxDecoration(),
                                    child: Column(
                                      mainAxisSize: MainAxisSize.max,
                                      children: [
                                        Padding(
                                          padding:
                                              EdgeInsetsDirectional.fromSTEB(
                                                  12.0, 60.0, 0.0, 0.0),
                                          child: Row(
                                            mainAxisSize: MainAxisSize.max,
                                            mainAxisAlignment:
                                                MainAxisAlignment.start,
                                            crossAxisAlignment:
                                                CrossAxisAlignment.center,
                                            children: [
                                              Flexible(
                                                child: Container(
                                                  width:
                                                      MediaQuery.sizeOf(context)
                                                              .width *
                                                          1.0,
                                                  child: Stack(
                                                    children: [
                                                      Align(
                                                        alignment:
                                                            AlignmentDirectional(
                                                                -1.0, 0.0),
                                                        child: Padding(
                                                          padding:
                                                              EdgeInsetsDirectional
                                                                  .fromSTEB(
                                                                      0.0,
                                                                      0.0,
                                                                      8.0,
                                                                      0.0),
                                                          child: InkWell(
                                                            splashColor: Colors
                                                                .transparent,
                                                            focusColor: Colors
                                                                .transparent,
                                                            hoverColor: Colors
                                                                .transparent,
                                                            highlightColor:
                                                                Colors
                                                                    .transparent,
                                                            onTap: () async {
                                                              context.safePop();
                                                            },
                                                            child: Icon(
                                                              Icons.arrow_back,
                                                              color: FlutterFlowTheme
                                                                      .of(context)
                                                                  .accent1,
                                                              size: 24.0,
                                                            ),
                                                          ),
                                                        ),
                                                      ),
                                                      Align(
                                                        alignment:
                                                            AlignmentDirectional(
                                                                0.0, 0.0),
                                                        child: Text(
                                                          FFLocalizations.of(
                                                                  context)
                                                              .getText(
                                                            '3yy96jh7' /* Scegli data e ora */,
                                                          ),
                                                          style: FlutterFlowTheme
                                                                  .of(context)
                                                              .bodyLarge
                                                              .override(
                                                                font:
                                                                    GoogleFonts
                                                                        .dmSans(
                                                                  fontWeight:
                                                                      FontWeight
                                                                          .bold,
                                                                  fontStyle: FlutterFlowTheme.of(
                                                                          context)
                                                                      .bodyLarge
                                                                      .fontStyle,
                                                                ),
                                                                fontSize: 16.0,
                                                                letterSpacing:
                                                                    0.0,
                                                                fontWeight:
                                                                    FontWeight
                                                                        .bold,
                                                                fontStyle: FlutterFlowTheme.of(
                                                                        context)
                                                                    .bodyLarge
                                                                    .fontStyle,
                                                              ),
                                                        ),
                                                      ),
                                                    ],
                                                  ),
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                        Divider(
                                          height: 20.0,
                                          thickness: 1.0,
                                          color: FlutterFlowTheme.of(context)
                                              .primary,
                                        ),
                                      ],
                                    ),
                                  ),
                                  Expanded(
                                    child: Container(
                                      width: MediaQuery.sizeOf(context).width *
                                          1.0,
                                      height:
                                          MediaQuery.sizeOf(context).height *
                                              0.75,
                                      decoration: BoxDecoration(
                                        color: FlutterFlowTheme.of(context)
                                            .secondaryBackground,
                                      ),
                                      child: Column(
                                        mainAxisSize: MainAxisSize.max,
                                        mainAxisAlignment:
                                            MainAxisAlignment.spaceBetween,
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Expanded(
                                            child: Container(
                                              width: MediaQuery.sizeOf(context)
                                                      .width *
                                                  1.0,
                                              height: double.infinity,
                                              decoration: BoxDecoration(),
                                              child: Column(
                                                mainAxisSize: MainAxisSize.max,
                                                crossAxisAlignment:
                                                    CrossAxisAlignment.start,
                                                children: [
                                                  Padding(
                                                    padding:
                                                        EdgeInsetsDirectional
                                                            .fromSTEB(12.0, 0.0,
                                                                12.0, 0.0),
                                                    child: FlutterFlowCalendar(
                                                      color:
                                                          FlutterFlowTheme.of(
                                                                  context)
                                                              .accent1,
                                                      iconColor:
                                                          FlutterFlowTheme.of(
                                                                  context)
                                                              .secondaryText,
                                                      weekFormat: true,
                                                      weekStartsMonday: true,
                                                      initialDate: widget
                                                                  .date !=
                                                              null
                                                          ? widget.date
                                                          : getCurrentTimestamp,
                                                      rowHeight: 80.0,
                                                      onChange: (DateTimeRange?
                                                          newSelectedDate) {
                                                        safeSetState(() => _model
                                                                .calendarSelectedDay =
                                                            newSelectedDate);
                                                      },
                                                      titleStyle:
                                                          FlutterFlowTheme.of(
                                                                  context)
                                                              .bodyLarge
                                                              .override(
                                                                font:
                                                                    GoogleFonts
                                                                        .dmSans(
                                                                  fontWeight:
                                                                      FontWeight
                                                                          .w500,
                                                                  fontStyle: FlutterFlowTheme.of(
                                                                          context)
                                                                      .bodyLarge
                                                                      .fontStyle,
                                                                ),
                                                                fontSize: 22.0,
                                                                letterSpacing:
                                                                    0.0,
                                                                fontWeight:
                                                                    FontWeight
                                                                        .w500,
                                                                fontStyle: FlutterFlowTheme.of(
                                                                        context)
                                                                    .bodyLarge
                                                                    .fontStyle,
                                                              ),
                                                      dayOfWeekStyle:
                                                          FlutterFlowTheme.of(
                                                                  context)
                                                              .labelLarge
                                                              .override(
                                                                font:
                                                                    GoogleFonts
                                                                        .dmSans(
                                                                  fontWeight: FlutterFlowTheme.of(
                                                                          context)
                                                                      .labelLarge
                                                                      .fontWeight,
                                                                  fontStyle: FlutterFlowTheme.of(
                                                                          context)
                                                                      .labelLarge
                                                                      .fontStyle,
                                                                ),
                                                                fontSize: 14.0,
                                                                letterSpacing:
                                                                    0.0,
                                                                fontWeight: FlutterFlowTheme.of(
                                                                        context)
                                                                    .labelLarge
                                                                    .fontWeight,
                                                                fontStyle: FlutterFlowTheme.of(
                                                                        context)
                                                                    .labelLarge
                                                                    .fontStyle,
                                                                lineHeight: 1.0,
                                                              ),
                                                      dateStyle:
                                                          FlutterFlowTheme.of(
                                                                  context)
                                                              .bodyMedium
                                                              .override(
                                                                font:
                                                                    GoogleFonts
                                                                        .dmSans(
                                                                  fontWeight: FlutterFlowTheme.of(
                                                                          context)
                                                                      .bodyMedium
                                                                      .fontWeight,
                                                                  fontStyle: FlutterFlowTheme.of(
                                                                          context)
                                                                      .bodyMedium
                                                                      .fontStyle,
                                                                ),
                                                                letterSpacing:
                                                                    0.0,
                                                                fontWeight: FlutterFlowTheme.of(
                                                                        context)
                                                                    .bodyMedium
                                                                    .fontWeight,
                                                                fontStyle: FlutterFlowTheme.of(
                                                                        context)
                                                                    .bodyMedium
                                                                    .fontStyle,
                                                              ),
                                                      selectedDateStyle:
                                                          FlutterFlowTheme.of(
                                                                  context)
                                                              .titleSmall
                                                              .override(
                                                                font:
                                                                    GoogleFonts
                                                                        .dmSans(
                                                                  fontWeight: FlutterFlowTheme.of(
                                                                          context)
                                                                      .titleSmall
                                                                      .fontWeight,
                                                                  fontStyle: FlutterFlowTheme.of(
                                                                          context)
                                                                      .titleSmall
                                                                      .fontStyle,
                                                                ),
                                                                letterSpacing:
                                                                    0.0,
                                                                fontWeight: FlutterFlowTheme.of(
                                                                        context)
                                                                    .titleSmall
                                                                    .fontWeight,
                                                                fontStyle: FlutterFlowTheme.of(
                                                                        context)
                                                                    .titleSmall
                                                                    .fontStyle,
                                                              ),
                                                      inactiveDateStyle:
                                                          FlutterFlowTheme.of(
                                                                  context)
                                                              .labelMedium
                                                              .override(
                                                                font:
                                                                    GoogleFonts
                                                                        .dmSans(
                                                                  fontWeight: FlutterFlowTheme.of(
                                                                          context)
                                                                      .labelMedium
                                                                      .fontWeight,
                                                                  fontStyle: FlutterFlowTheme.of(
                                                                          context)
                                                                      .labelMedium
                                                                      .fontStyle,
                                                                ),
                                                                letterSpacing:
                                                                    0.0,
                                                                fontWeight: FlutterFlowTheme.of(
                                                                        context)
                                                                    .labelMedium
                                                                    .fontWeight,
                                                                fontStyle: FlutterFlowTheme.of(
                                                                        context)
                                                                    .labelMedium
                                                                    .fontStyle,
                                                              ),
                                                      locale:
                                                          FFLocalizations.of(
                                                                  context)
                                                              .languageCode,
                                                    ),
                                                  ),
                                                  Expanded(
                                                    child: FutureBuilder<
                                                        List<
                                                            AppointmentsRecord>>(
                                                      future:
                                                          queryAppointmentsRecordOnce(
                                                        queryBuilder:
                                                            (appointmentsRecord) =>
                                                                appointmentsRecord
                                                                    .where(
                                                                      'startDate',
                                                                      isGreaterThan: functions.startOfDay(_model
                                                                          .calendarSelectedDay!
                                                                          .end),
                                                                    )
                                                                    .where(
                                                                      'startDate',
                                                                      isLessThan: functions.endOfDay(_model
                                                                          .calendarSelectedDay!
                                                                          .end),
                                                                    )
                                                                    .where(
                                                                      'workers',
                                                                      arrayContains: widget
                                                                          .worker
                                                                          ?.reference,
                                                                    ),
                                                      ),
                                                      builder:
                                                          (context, snapshot) {
                                                        // Customize what your widget looks like when it's loading.
                                                        if (!snapshot.hasData) {
                                                          return Center(
                                                            child: SizedBox(
                                                              width: 40.0,
                                                              height: 40.0,
                                                              child:
                                                                  SpinKitThreeBounce(
                                                                color: FlutterFlowTheme.of(
                                                                        context)
                                                                    .primary,
                                                                size: 40.0,
                                                              ),
                                                            ),
                                                          );
                                                        }
                                                        List<AppointmentsRecord>
                                                            containerAppointmentsRecordList =
                                                            snapshot.data!;

                                                        return Container(
                                                          width:
                                                              MediaQuery.sizeOf(
                                                                          context)
                                                                      .width *
                                                                  1.0,
                                                          height: 100.0,
                                                          decoration:
                                                              BoxDecoration(
                                                            color: FlutterFlowTheme
                                                                    .of(context)
                                                                .secondaryBackground,
                                                          ),
                                                          child: Builder(
                                                            builder: (context) {
                                                              if (functions.generateWorkerAvailableTimeSlots(
                                                                          containerAppointmentsRecordList
                                                                              .toList(),
                                                                          8,
                                                                          19,
                                                                          30,
                                                                          widget
                                                                              .worker
                                                                              ?.reference,
                                                                          _model
                                                                              .calendarSelectedDay!
                                                                              .end,
                                                                          10) !=
                                                                      null &&
                                                                  (functions.generateWorkerAvailableTimeSlots(
                                                                          containerAppointmentsRecordList
                                                                              .toList(),
                                                                          8,
                                                                          19,
                                                                          30,
                                                                          widget
                                                                              .worker
                                                                              ?.reference,
                                                                          _model
                                                                              .calendarSelectedDay!
                                                                              .end,
                                                                          10))!
                                                                      .isNotEmpty) {
                                                                return Column(
                                                                  mainAxisSize:
                                                                      MainAxisSize
                                                                          .max,
                                                                  crossAxisAlignment:
                                                                      CrossAxisAlignment
                                                                          .start,
                                                                  children: [
                                                                    Expanded(
                                                                      child:
                                                                          Padding(
                                                                        padding: EdgeInsetsDirectional.fromSTEB(
                                                                            24.0,
                                                                            24.0,
                                                                            24.0,
                                                                            0.0),
                                                                        child:
                                                                            FlutterFlowRadioButton(
                                                                          options: functions
                                                                              .generateWorkerAvailableTimeSlots(containerAppointmentsRecordList.toList(), 8, 19, 30, widget.worker?.reference, _model.calendarSelectedDay!.end, 0)!
                                                                              .map((e) => e.toString())
                                                                              .toList(),
                                                                          onChanged: (val) =>
                                                                              safeSetState(() {}),
                                                                          controller: _model
                                                                              .radioButtonValueController ??= FormFieldController<String>(widget.time != null &&
                                                                                  widget.time != ''
                                                                              ? widget.time!
                                                                              : ' '),
                                                                          optionHeight:
                                                                              48.0,
                                                                          optionWidth:
                                                                              MediaQuery.sizeOf(context).width * 0.3,
                                                                          textStyle: FlutterFlowTheme.of(context)
                                                                              .bodyLarge
                                                                              .override(
                                                                                font: GoogleFonts.dmSans(
                                                                                  fontWeight: FontWeight.w500,
                                                                                  fontStyle: FlutterFlowTheme.of(context).bodyLarge.fontStyle,
                                                                                ),
                                                                                fontSize: 17.0,
                                                                                letterSpacing: 0.0,
                                                                                fontWeight: FontWeight.w500,
                                                                                fontStyle: FlutterFlowTheme.of(context).bodyLarge.fontStyle,
                                                                              ),
                                                                          selectedTextStyle: FlutterFlowTheme.of(context)
                                                                              .bodyLarge
                                                                              .override(
                                                                                font: GoogleFonts.dmSans(
                                                                                  fontWeight: FontWeight.bold,
                                                                                  fontStyle: FlutterFlowTheme.of(context).bodyLarge.fontStyle,
                                                                                ),
                                                                                fontSize: 19.0,
                                                                                letterSpacing: 0.0,
                                                                                fontWeight: FontWeight.bold,
                                                                                fontStyle: FlutterFlowTheme.of(context).bodyLarge.fontStyle,
                                                                              ),
                                                                          buttonPosition:
                                                                              RadioButtonPosition.left,
                                                                          direction:
                                                                              Axis.vertical,
                                                                          radioButtonColor:
                                                                              FlutterFlowTheme.of(context).accent1,
                                                                          inactiveRadioButtonColor:
                                                                              FlutterFlowTheme.of(context).primaryBackground,
                                                                          toggleable:
                                                                              false,
                                                                          horizontalAlignment:
                                                                              WrapAlignment.start,
                                                                          verticalAlignment:
                                                                              WrapCrossAlignment.start,
                                                                        ),
                                                                      ),
                                                                    ),
                                                                    Align(
                                                                      alignment:
                                                                          AlignmentDirectional(
                                                                              0.0,
                                                                              0.0),
                                                                      child:
                                                                          Padding(
                                                                        padding: EdgeInsetsDirectional.fromSTEB(
                                                                            0.0,
                                                                            0.0,
                                                                            0.0,
                                                                            48.0),
                                                                        child:
                                                                            Container(
                                                                          width:
                                                                              MediaQuery.sizeOf(context).width * 1.0,
                                                                          height:
                                                                              90.0,
                                                                          decoration:
                                                                              BoxDecoration(
                                                                            color:
                                                                                FlutterFlowTheme.of(context).secondaryBackground,
                                                                          ),
                                                                          child:
                                                                              Padding(
                                                                            padding: EdgeInsetsDirectional.fromSTEB(
                                                                                24.0,
                                                                                12.0,
                                                                                24.0,
                                                                                24.0),
                                                                            child:
                                                                                Column(
                                                                              mainAxisSize: MainAxisSize.max,
                                                                              mainAxisAlignment: MainAxisAlignment.center,
                                                                              children: [
                                                                                FFButtonWidget(
                                                                                  onPressed: () async {
                                                                                    if (widget.isFromSecondAgenda) {
                                                                                      var appointmentsRecordReference1 = AppointmentsRecord.collection.doc();
                                                                                      await appointmentsRecordReference1.set(createAppointmentsRecordData(
                                                                                        startDate: functions.combineDateTimeAndTimeString(_model.calendarSelectedDay!.end, _model.radioButtonValue!),
                                                                                        endDate: _model.calendarSelectedDay?.end,
                                                                                        price: widget.service?.price,
                                                                                        duration: widget.service?.duration,
                                                                                        client: widget.client?.reference,
                                                                                        email: widget.client?.email,
                                                                                        clientData: createClientDataStruct(
                                                                                          name: widget.client?.name,
                                                                                          email: widget.client?.email,
                                                                                          surname: widget.client?.surname,
                                                                                          clearUnsetFields: false,
                                                                                          create: true,
                                                                                        ),
                                                                                        canceled: false,
                                                                                        serviceData: updateServiceDataStruct(
                                                                                          ServiceDataStruct(
                                                                                            name: widget.service?.name,
                                                                                            duration: widget.service?.duration,
                                                                                            price: widget.service?.price,
                                                                                            staffInvolved: widget.service?.staffInvolved,
                                                                                            serviceReference: widget.service?.reference,
                                                                                            categoryName: widget.serviceName,
                                                                                          ),
                                                                                          clearUnsetFields: false,
                                                                                          create: true,
                                                                                        ),
                                                                                        accomodation: FFAppState().selectedAccomodation.accomodation,
                                                                                        isSecondAgenda: true,
                                                                                      ));
                                                                                      _model.appointmentData1 = AppointmentsRecord.getDocumentFromData(
                                                                                          createAppointmentsRecordData(
                                                                                            startDate: functions.combineDateTimeAndTimeString(_model.calendarSelectedDay!.end, _model.radioButtonValue!),
                                                                                            endDate: _model.calendarSelectedDay?.end,
                                                                                            price: widget.service?.price,
                                                                                            duration: widget.service?.duration,
                                                                                            client: widget.client?.reference,
                                                                                            email: widget.client?.email,
                                                                                            clientData: createClientDataStruct(
                                                                                              name: widget.client?.name,
                                                                                              email: widget.client?.email,
                                                                                              surname: widget.client?.surname,
                                                                                              clearUnsetFields: false,
                                                                                              create: true,
                                                                                            ),
                                                                                            canceled: false,
                                                                                            serviceData: updateServiceDataStruct(
                                                                                              ServiceDataStruct(
                                                                                                name: widget.service?.name,
                                                                                                duration: widget.service?.duration,
                                                                                                price: widget.service?.price,
                                                                                                staffInvolved: widget.service?.staffInvolved,
                                                                                                serviceReference: widget.service?.reference,
                                                                                                categoryName: widget.serviceName,
                                                                                              ),
                                                                                              clearUnsetFields: false,
                                                                                              create: true,
                                                                                            ),
                                                                                            accomodation: FFAppState().selectedAccomodation.accomodation,
                                                                                            isSecondAgenda: true,
                                                                                          ),
                                                                                          appointmentsRecordReference1);
                                                                                      _model.addToAppointments(_model.appointmentData1!);
                                                                                    } else {
                                                                                      var appointmentsRecordReference2 = AppointmentsRecord.collection.doc();
                                                                                      await appointmentsRecordReference2.set({
                                                                                        ...createAppointmentsRecordData(
                                                                                          startDate: functions.combineDateTimeAndTimeString(_model.calendarSelectedDay!.end, _model.radioButtonValue!),
                                                                                          endDate: _model.calendarSelectedDay?.end,
                                                                                          price: widget.service?.price,
                                                                                          duration: widget.service?.duration,
                                                                                          client: widget.client?.reference,
                                                                                          email: widget.client?.email,
                                                                                          clientData: createClientDataStruct(
                                                                                            name: widget.client?.name,
                                                                                            email: widget.client?.email,
                                                                                            surname: widget.client?.surname,
                                                                                            clearUnsetFields: false,
                                                                                            create: true,
                                                                                          ),
                                                                                          canceled: false,
                                                                                          serviceData: updateServiceDataStruct(
                                                                                            ServiceDataStruct(
                                                                                              name: widget.service?.name,
                                                                                              duration: widget.service?.duration,
                                                                                              price: widget.service?.price,
                                                                                              staffInvolved: widget.service?.staffInvolved,
                                                                                              serviceReference: widget.service?.reference,
                                                                                            ),
                                                                                            clearUnsetFields: false,
                                                                                            create: true,
                                                                                          ),
                                                                                          accomodation: FFAppState().selectedAccomodation.accomodation,
                                                                                          isSecondAgenda: false,
                                                                                        ),
                                                                                        ...mapToFirestore(
                                                                                          {
                                                                                            'workers': [
                                                                                              widget.worker?.reference
                                                                                            ],
                                                                                            'workersData': [
                                                                                              getWorkerDataFirestoreData(
                                                                                                createWorkerDataStruct(
                                                                                                  name: widget.worker?.name,
                                                                                                  clearUnsetFields: false,
                                                                                                  create: true,
                                                                                                ),
                                                                                                true,
                                                                                              )
                                                                                            ],
                                                                                          },
                                                                                        ),
                                                                                      });
                                                                                      _model.appointmentData = AppointmentsRecord.getDocumentFromData({
                                                                                        ...createAppointmentsRecordData(
                                                                                          startDate: functions.combineDateTimeAndTimeString(_model.calendarSelectedDay!.end, _model.radioButtonValue!),
                                                                                          endDate: _model.calendarSelectedDay?.end,
                                                                                          price: widget.service?.price,
                                                                                          duration: widget.service?.duration,
                                                                                          client: widget.client?.reference,
                                                                                          email: widget.client?.email,
                                                                                          clientData: createClientDataStruct(
                                                                                            name: widget.client?.name,
                                                                                            email: widget.client?.email,
                                                                                            surname: widget.client?.surname,
                                                                                            clearUnsetFields: false,
                                                                                            create: true,
                                                                                          ),
                                                                                          canceled: false,
                                                                                          serviceData: updateServiceDataStruct(
                                                                                            ServiceDataStruct(
                                                                                              name: widget.service?.name,
                                                                                              duration: widget.service?.duration,
                                                                                              price: widget.service?.price,
                                                                                              staffInvolved: widget.service?.staffInvolved,
                                                                                              serviceReference: widget.service?.reference,
                                                                                            ),
                                                                                            clearUnsetFields: false,
                                                                                            create: true,
                                                                                          ),
                                                                                          accomodation: FFAppState().selectedAccomodation.accomodation,
                                                                                          isSecondAgenda: false,
                                                                                        ),
                                                                                        ...mapToFirestore(
                                                                                          {
                                                                                            'workers': [
                                                                                              widget.worker?.reference
                                                                                            ],
                                                                                            'workersData': [
                                                                                              getWorkerDataFirestoreData(
                                                                                                createWorkerDataStruct(
                                                                                                  name: widget.worker?.name,
                                                                                                  clearUnsetFields: false,
                                                                                                  create: true,
                                                                                                ),
                                                                                                true,
                                                                                              )
                                                                                            ],
                                                                                          },
                                                                                        ),
                                                                                      }, appointmentsRecordReference2);
                                                                                      _model.addToAppointments(_model.appointmentData!);
                                                                                    }

                                                                                    if (widget.currentReservation == widget.service?.calendarReservations) {
                                                                                      await widget.client!.reference.update({
                                                                                        ...mapToFirestore(
                                                                                          {
                                                                                            'toPay': FieldValue.increment(widget.service!.price),
                                                                                          },
                                                                                        ),
                                                                                      });

                                                                                      var salesRecordReference = SalesRecord.collection.doc();
                                                                                      await salesRecordReference.set({
                                                                                        ...createSalesRecordData(
                                                                                          amount: widget.service?.price,
                                                                                          client: createClientDataStruct(
                                                                                            name: widget.client?.name,
                                                                                            email: widget.client?.email,
                                                                                            surname: widget.client?.surname,
                                                                                            clientRef: widget.client?.reference,
                                                                                            clearUnsetFields: false,
                                                                                            create: true,
                                                                                          ),
                                                                                          service: createServiceDataStruct(
                                                                                            name: widget.service?.name,
                                                                                            duration: widget.service?.duration,
                                                                                            price: widget.service?.price,
                                                                                            staffInvolved: widget.service?.staffInvolved,
                                                                                            serviceReference: widget.service?.reference,
                                                                                            fieldValues: {
                                                                                              'appointmentsData': getAppointmentDataListFirestoreData(
                                                                                                functions.createAppointmentsData(_model.appointments.toList()),
                                                                                              ),
                                                                                            },
                                                                                            clearUnsetFields: false,
                                                                                            create: true,
                                                                                          ),
                                                                                          accomodation: FFAppState().selectedAccomodation.accomodation,
                                                                                        ),
                                                                                        ...mapToFirestore(
                                                                                          {
                                                                                            'create_time': FieldValue.serverTimestamp(),
                                                                                          },
                                                                                        ),
                                                                                      });
                                                                                      _model.saleDoc = SalesRecord.getDocumentFromData({
                                                                                        ...createSalesRecordData(
                                                                                          amount: widget.service?.price,
                                                                                          client: createClientDataStruct(
                                                                                            name: widget.client?.name,
                                                                                            email: widget.client?.email,
                                                                                            surname: widget.client?.surname,
                                                                                            clientRef: widget.client?.reference,
                                                                                            clearUnsetFields: false,
                                                                                            create: true,
                                                                                          ),
                                                                                          service: createServiceDataStruct(
                                                                                            name: widget.service?.name,
                                                                                            duration: widget.service?.duration,
                                                                                            price: widget.service?.price,
                                                                                            staffInvolved: widget.service?.staffInvolved,
                                                                                            serviceReference: widget.service?.reference,
                                                                                            fieldValues: {
                                                                                              'appointmentsData': getAppointmentDataListFirestoreData(
                                                                                                functions.createAppointmentsData(_model.appointments.toList()),
                                                                                              ),
                                                                                            },
                                                                                            clearUnsetFields: false,
                                                                                            create: true,
                                                                                          ),
                                                                                          accomodation: FFAppState().selectedAccomodation.accomodation,
                                                                                        ),
                                                                                        ...mapToFirestore(
                                                                                          {
                                                                                            'create_time': DateTime.now(),
                                                                                          },
                                                                                        ),
                                                                                      }, salesRecordReference);

                                                                                      context.pushNamed(
                                                                                        SaleConfirmWidget.routeName,
                                                                                        queryParameters: {
                                                                                          'sale': serializeParam(
                                                                                            _model.saleDoc,
                                                                                            ParamType.Document,
                                                                                          ),
                                                                                          'client': serializeParam(
                                                                                            widget.client,
                                                                                            ParamType.Document,
                                                                                          ),
                                                                                        }.withoutNulls,
                                                                                        extra: <String, dynamic>{
                                                                                          'sale': _model.saleDoc,
                                                                                          'client': widget.client,
                                                                                        },
                                                                                      );
                                                                                    } else {
                                                                                      context.pushNamed(
                                                                                        BookingOperatorsSelectionWidget.routeName,
                                                                                        queryParameters: {
                                                                                          'service': serializeParam(
                                                                                            widget.service,
                                                                                            ParamType.Document,
                                                                                          ),
                                                                                          'client': serializeParam(
                                                                                            widget.client,
                                                                                            ParamType.Document,
                                                                                          ),
                                                                                          'currentReservation': serializeParam(
                                                                                            (widget.currentReservation!) + 1,
                                                                                            ParamType.int,
                                                                                          ),
                                                                                          'appointments': serializeParam(
                                                                                            _model.appointments,
                                                                                            ParamType.Document,
                                                                                            isList: true,
                                                                                          ),
                                                                                        }.withoutNulls,
                                                                                        extra: <String, dynamic>{
                                                                                          'service': widget.service,
                                                                                          'client': widget.client,
                                                                                          'appointments': _model.appointments,
                                                                                        },
                                                                                      );
                                                                                    }

                                                                                    safeSetState(() {});
                                                                                  },
                                                                                  text: FFLocalizations.of(context).getText(
                                                                                    'wppa5rgt' /* Conferma */,
                                                                                  ),
                                                                                  options: FFButtonOptions(
                                                                                    width: 350.0,
                                                                                    height: 40.0,
                                                                                    padding: EdgeInsetsDirectional.fromSTEB(24.0, 0.0, 24.0, 0.0),
                                                                                    iconPadding: EdgeInsetsDirectional.fromSTEB(0.0, 0.0, 0.0, 0.0),
                                                                                    color: FlutterFlowTheme.of(context).accent1,
                                                                                    textStyle: FlutterFlowTheme.of(context).titleSmall.override(
                                                                                          font: GoogleFonts.dmSans(
                                                                                            fontWeight: FlutterFlowTheme.of(context).titleSmall.fontWeight,
                                                                                            fontStyle: FlutterFlowTheme.of(context).titleSmall.fontStyle,
                                                                                          ),
                                                                                          color: Colors.white,
                                                                                          letterSpacing: 0.0,
                                                                                          fontWeight: FlutterFlowTheme.of(context).titleSmall.fontWeight,
                                                                                          fontStyle: FlutterFlowTheme.of(context).titleSmall.fontStyle,
                                                                                        ),
                                                                                    elevation: 3.0,
                                                                                    borderSide: BorderSide(
                                                                                      color: Colors.transparent,
                                                                                      width: 1.0,
                                                                                    ),
                                                                                    borderRadius: BorderRadius.circular(8.0),
                                                                                  ),
                                                                                ),
                                                                              ],
                                                                            ),
                                                                          ),
                                                                        ),
                                                                      ),
                                                                    ),
                                                                  ],
                                                                );
                                                              } else {
                                                                return Column(
                                                                  mainAxisSize:
                                                                      MainAxisSize
                                                                          .max,
                                                                  mainAxisAlignment:
                                                                      MainAxisAlignment
                                                                          .center,
                                                                  children: [
                                                                    Padding(
                                                                      padding: EdgeInsetsDirectional.fromSTEB(
                                                                          0.0,
                                                                          0.0,
                                                                          0.0,
                                                                          15.0),
                                                                      child:
                                                                          Icon(
                                                                        Icons
                                                                            .no_backpack_outlined,
                                                                        color: FlutterFlowTheme.of(context)
                                                                            .secondaryText,
                                                                        size:
                                                                            96.0,
                                                                      ),
                                                                    ),
                                                                    Text(
                                                                      FFLocalizations.of(
                                                                              context)
                                                                          .getText(
                                                                        'd56ks1v0' /* Nessun appuntamento disponibil... */,
                                                                      ),
                                                                      style: FlutterFlowTheme.of(
                                                                              context)
                                                                          .labelLarge
                                                                          .override(
                                                                            font:
                                                                                GoogleFonts.dmSans(
                                                                              fontWeight: FlutterFlowTheme.of(context).labelLarge.fontWeight,
                                                                              fontStyle: FlutterFlowTheme.of(context).labelLarge.fontStyle,
                                                                            ),
                                                                            letterSpacing:
                                                                                0.0,
                                                                            fontWeight:
                                                                                FlutterFlowTheme.of(context).labelLarge.fontWeight,
                                                                            fontStyle:
                                                                                FlutterFlowTheme.of(context).labelLarge.fontStyle,
                                                                          ),
                                                                    ),
                                                                  ],
                                                                );
                                                              }
                                                            },
                                                          ),
                                                        );
                                                      },
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ));
  }
}
