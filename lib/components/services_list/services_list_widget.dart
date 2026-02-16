import '/backend/backend.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/flutter_flow/custom_functions.dart' as functions;
import '/index.dart';
import 'package:expandable/expandable.dart';
import 'package:flutter/material.dart';
import 'package:font_awesome_flutter/font_awesome_flutter.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'services_list_model.dart';
export 'services_list_model.dart';

class ServicesListWidget extends StatefulWidget {
  const ServicesListWidget({
    super.key,
    required this.client,
    required this.currentReservation,
    this.date,
    this.time,
    this.operator,
    this.serviceCategoryAgenda,
    bool? isFromSecondAgenda,
    this.serviceName,
  }) : this.isFromSecondAgenda = isFromSecondAgenda ?? false;

  final ClientsRecord? client;
  final int? currentReservation;
  final DateTime? date;
  final String? time;
  final WorkersRecord? operator;
  final DocumentReference? serviceCategoryAgenda;
  final bool isFromSecondAgenda;
  final String? serviceName;

  @override
  State<ServicesListWidget> createState() => _ServicesListWidgetState();
}

class _ServicesListWidgetState extends State<ServicesListWidget> {
  late ServicesListModel _model;

  @override
  void setState(VoidCallback callback) {
    super.setState(callback);
    _model.onUpdate();
  }

  @override
  void initState() {
    super.initState();
    _model = createModel(context, () => ServicesListModel());

    WidgetsBinding.instance.addPostFrameCallback((_) => safeSetState(() {}));
  }

  @override
  void dispose() {
    _model.maybeDispose();

    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    context.watch<FFAppState>();

    return StreamBuilder<List<ServiceCategoriesRecord>>(
      stream: queryServiceCategoriesRecord(
        queryBuilder: (serviceCategoriesRecord) =>
            serviceCategoriesRecord.where(
          'name',
          isEqualTo: widget.serviceName,
        ),
      ),
      builder: (context, snapshot) {
        // Customize what your widget looks like when it's loading.
        if (!snapshot.hasData) {
          return Center(
            child: SizedBox(
              width: 50.0,
              height: 50.0,
              child: CircularProgressIndicator(
                valueColor: AlwaysStoppedAnimation<Color>(
                  FlutterFlowTheme.of(context).primary,
                ),
              ),
            ),
          );
        }
        List<ServiceCategoriesRecord> containerServiceCategoriesRecordList =
            snapshot.data!;

        return Container(
          width: MediaQuery.sizeOf(context).width * 1.0,
          height: double.infinity,
          decoration: BoxDecoration(
            color: FlutterFlowTheme.of(context).secondaryBackground,
          ),
          child: Builder(
            builder: (context) {
              final serviceCategories =
                  containerServiceCategoriesRecordList.toList();

              return ListView.builder(
                padding: EdgeInsets.zero,
                scrollDirection: Axis.vertical,
                itemCount: serviceCategories.length,
                itemBuilder: (context, serviceCategoriesIndex) {
                  final serviceCategoriesItem =
                      serviceCategories[serviceCategoriesIndex];
                  return FutureBuilder<List<AccomodationServicesRecord>>(
                    future: queryAccomodationServicesRecordOnce(
                      queryBuilder: (accomodationServicesRecord) =>
                          accomodationServicesRecord
                              .where(
                                'category',
                                isEqualTo: serviceCategoriesItem.reference,
                              )
                              .where(
                                'calendarReservations',
                                isEqualTo: 1,
                              )
                              .where(
                                'accomodation',
                                isEqualTo: FFAppState()
                                    .selectedAccomodation
                                    .accomodation,
                              ),
                    ),
                    builder: (context, snapshot) {
                      // Customize what your widget looks like when it's loading.
                      if (!snapshot.hasData) {
                        return Center(
                          child: SizedBox(
                            width: 50.0,
                            height: 50.0,
                            child: CircularProgressIndicator(
                              valueColor: AlwaysStoppedAnimation<Color>(
                                FlutterFlowTheme.of(context).primary,
                              ),
                            ),
                          ),
                        );
                      }
                      List<AccomodationServicesRecord>
                          expandableAccomodationServicesRecordList =
                          snapshot.data!;

                      return Container(
                        width: MediaQuery.sizeOf(context).width * 1.0,
                        color: Color(0x00000000),
                        child: ExpandableNotifier(
                          initialExpanded: false,
                          child: ExpandablePanel(
                            header: Row(
                              mainAxisSize: MainAxisSize.max,
                              mainAxisAlignment: MainAxisAlignment.start,
                              children: [
                                Padding(
                                  padding: EdgeInsetsDirectional.fromSTEB(
                                      24.0, 0.0, 0.0, 0.0),
                                  child: Text(
                                    serviceCategoriesItem.name,
                                    style: FlutterFlowTheme.of(context)
                                        .bodyLarge
                                        .override(
                                          font: GoogleFonts.dmSans(
                                            fontWeight: FontWeight.bold,
                                            fontStyle:
                                                FlutterFlowTheme.of(context)
                                                    .bodyLarge
                                                    .fontStyle,
                                          ),
                                          color: FlutterFlowTheme.of(context)
                                              .primaryText,
                                          fontSize: 17.0,
                                          letterSpacing: 0.0,
                                          fontWeight: FontWeight.bold,
                                          fontStyle:
                                              FlutterFlowTheme.of(context)
                                                  .bodyLarge
                                                  .fontStyle,
                                        ),
                                  ),
                                ),
                              ],
                            ),
                            collapsed: Container(),
                            expanded: Align(
                              alignment: AlignmentDirectional(0.0, 0.0),
                              child: Padding(
                                padding: EdgeInsetsDirectional.fromSTEB(
                                    0.0, 0.0, 0.0, 24.0),
                                child: Builder(
                                  builder: (context) {
                                    final categoryProducts =
                                        expandableAccomodationServicesRecordList
                                            .toList();

                                    return Column(
                                      mainAxisSize: MainAxisSize.max,
                                      children:
                                          List.generate(categoryProducts.length,
                                              (categoryProductsIndex) {
                                        final categoryProductsItem =
                                            categoryProducts[
                                                categoryProductsIndex];
                                        return Container(
                                          width:
                                              MediaQuery.sizeOf(context).width *
                                                  1.0,
                                          decoration: BoxDecoration(
                                            color: FlutterFlowTheme.of(context)
                                                .primaryBackground,
                                          ),
                                          child: Padding(
                                            padding:
                                                EdgeInsetsDirectional.fromSTEB(
                                                    24.0, 12.0, 24.0, 12.0),
                                            child: Row(
                                              mainAxisSize: MainAxisSize.max,
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.center,
                                              children: [
                                                Expanded(
                                                  child: Column(
                                                    mainAxisSize:
                                                        MainAxisSize.max,
                                                    crossAxisAlignment:
                                                        CrossAxisAlignment
                                                            .start,
                                                    children: [
                                                      Text(
                                                        categoryProductsItem
                                                            .name,
                                                        style: FlutterFlowTheme
                                                                .of(context)
                                                            .bodyMedium
                                                            .override(
                                                              font: GoogleFonts
                                                                  .dmSans(
                                                                fontWeight:
                                                                    FontWeight
                                                                        .w500,
                                                                fontStyle: FlutterFlowTheme.of(
                                                                        context)
                                                                    .bodyMedium
                                                                    .fontStyle,
                                                              ),
                                                              fontSize: 17.0,
                                                              letterSpacing:
                                                                  0.0,
                                                              fontWeight:
                                                                  FontWeight
                                                                      .w500,
                                                              fontStyle:
                                                                  FlutterFlowTheme.of(
                                                                          context)
                                                                      .bodyMedium
                                                                      .fontStyle,
                                                            ),
                                                      ),
                                                      Padding(
                                                        padding:
                                                            EdgeInsetsDirectional
                                                                .fromSTEB(
                                                                    0.0,
                                                                    4.0,
                                                                    0.0,
                                                                    0.0),
                                                        child: Row(
                                                          mainAxisSize:
                                                              MainAxisSize.max,
                                                          children: [
                                                            Icon(
                                                              Icons
                                                                  .info_outline,
                                                              color: FlutterFlowTheme
                                                                      .of(context)
                                                                  .secondaryText,
                                                              size: 16.0,
                                                            ),
                                                            Padding(
                                                              padding:
                                                                  EdgeInsetsDirectional
                                                                      .fromSTEB(
                                                                          4.0,
                                                                          0.0,
                                                                          0.0,
                                                                          0.0),
                                                              child: Text(
                                                                FFLocalizations.of(
                                                                        context)
                                                                    .getText(
                                                                  'z26vs4vo' /* Descrizione */,
                                                                ),
                                                                style: FlutterFlowTheme.of(
                                                                        context)
                                                                    .bodyMedium
                                                                    .override(
                                                                      font: GoogleFonts
                                                                          .dmSans(
                                                                        fontWeight: FlutterFlowTheme.of(context)
                                                                            .bodyMedium
                                                                            .fontWeight,
                                                                        fontStyle: FlutterFlowTheme.of(context)
                                                                            .bodyMedium
                                                                            .fontStyle,
                                                                      ),
                                                                      fontSize:
                                                                          14.0,
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
                                                              ),
                                                            ),
                                                          ],
                                                        ),
                                                      ),
                                                    ],
                                                  ),
                                                ),
                                                Row(
                                                  mainAxisSize:
                                                      MainAxisSize.max,
                                                  children: [
                                                    Text(
                                                      formatNumber(
                                                        categoryProductsItem
                                                            .price,
                                                        formatType:
                                                            FormatType.decimal,
                                                        decimalType: DecimalType
                                                            .commaDecimal,
                                                      ),
                                                      style:
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
                                                                color: FlutterFlowTheme.of(
                                                                        context)
                                                                    .accent1,
                                                                fontSize: 17.0,
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
                                                    ),
                                                    Padding(
                                                      padding:
                                                          EdgeInsetsDirectional
                                                              .fromSTEB(
                                                                  2.0,
                                                                  0.0,
                                                                  16.0,
                                                                  0.0),
                                                      child: Text(
                                                        FFLocalizations.of(
                                                                context)
                                                            .getText(
                                                          '3smj3zg7' /* € */,
                                                        ),
                                                        style:
                                                            FlutterFlowTheme.of(
                                                                    context)
                                                                .bodyMedium
                                                                .override(
                                                                  font: GoogleFonts
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
                                                                  color: FlutterFlowTheme.of(
                                                                          context)
                                                                      .accent1,
                                                                  fontSize:
                                                                      16.0,
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
                                                      ),
                                                    ),
                                                    InkWell(
                                                      splashColor:
                                                          Colors.transparent,
                                                      focusColor:
                                                          Colors.transparent,
                                                      hoverColor:
                                                          Colors.transparent,
                                                      highlightColor:
                                                          Colors.transparent,
                                                      onTap: () async {
                                                        if (((widget.operator !=
                                                                    null) ||
                                                                widget
                                                                    .isFromSecondAgenda) &&
                                                            (widget.date !=
                                                                null)) {
                                                          if (widget
                                                              .isFromSecondAgenda) {
                                                            var appointmentsRecordReference1 =
                                                                AppointmentsRecord
                                                                    .collection
                                                                    .doc();
                                                            await appointmentsRecordReference1
                                                                .set(
                                                                    createAppointmentsRecordData(
                                                              startDate: functions
                                                                  .combineDateTimeAndTimeString(
                                                                      widget
                                                                          .date!,
                                                                      widget
                                                                          .time!),
                                                              endDate:
                                                                  widget.date,
                                                              price:
                                                                  categoryProductsItem
                                                                      .price,
                                                              duration:
                                                                  categoryProductsItem
                                                                      .duration,
                                                              client: widget
                                                                  .client
                                                                  ?.reference,
                                                              email: widget
                                                                  .client
                                                                  ?.email,
                                                              clientData:
                                                                  createClientDataStruct(
                                                                name: widget
                                                                    .client
                                                                    ?.name,
                                                                email: widget
                                                                    .client
                                                                    ?.email,
                                                                surname: widget
                                                                    .client
                                                                    ?.surname,
                                                                clearUnsetFields:
                                                                    false,
                                                                create: true,
                                                              ),
                                                              canceled: false,
                                                              serviceData:
                                                                  updateServiceDataStruct(
                                                                ServiceDataStruct(
                                                                  name:
                                                                      categoryProductsItem
                                                                          .name,
                                                                  duration:
                                                                      categoryProductsItem
                                                                          .duration,
                                                                  price:
                                                                      categoryProductsItem
                                                                          .price,
                                                                  staffInvolved:
                                                                      categoryProductsItem
                                                                          .staffInvolved,
                                                                  serviceReference:
                                                                      categoryProductsItem
                                                                          .reference,
                                                                  categoryName:
                                                                      widget
                                                                          .serviceName,
                                                                ),
                                                                clearUnsetFields:
                                                                    false,
                                                                create: true,
                                                              ),
                                                              accomodation: FFAppState()
                                                                  .selectedAccomodation
                                                                  .accomodation,
                                                              isSecondAgenda:
                                                                  widget
                                                                      .isFromSecondAgenda,
                                                            ));
                                                            _model.appointment1 =
                                                                AppointmentsRecord
                                                                    .getDocumentFromData(
                                                                        createAppointmentsRecordData(
                                                                          startDate: functions.combineDateTimeAndTimeString(
                                                                              widget.date!,
                                                                              widget.time!),
                                                                          endDate:
                                                                              widget.date,
                                                                          price:
                                                                              categoryProductsItem.price,
                                                                          duration:
                                                                              categoryProductsItem.duration,
                                                                          client: widget
                                                                              .client
                                                                              ?.reference,
                                                                          email: widget
                                                                              .client
                                                                              ?.email,
                                                                          clientData:
                                                                              createClientDataStruct(
                                                                            name:
                                                                                widget.client?.name,
                                                                            email:
                                                                                widget.client?.email,
                                                                            surname:
                                                                                widget.client?.surname,
                                                                            clearUnsetFields:
                                                                                false,
                                                                            create:
                                                                                true,
                                                                          ),
                                                                          canceled:
                                                                              false,
                                                                          serviceData:
                                                                              updateServiceDataStruct(
                                                                            ServiceDataStruct(
                                                                              name: categoryProductsItem.name,
                                                                              duration: categoryProductsItem.duration,
                                                                              price: categoryProductsItem.price,
                                                                              staffInvolved: categoryProductsItem.staffInvolved,
                                                                              serviceReference: categoryProductsItem.reference,
                                                                              categoryName: widget.serviceName,
                                                                            ),
                                                                            clearUnsetFields:
                                                                                false,
                                                                            create:
                                                                                true,
                                                                          ),
                                                                          accomodation: FFAppState()
                                                                              .selectedAccomodation
                                                                              .accomodation,
                                                                          isSecondAgenda:
                                                                              widget.isFromSecondAgenda,
                                                                        ),
                                                                        appointmentsRecordReference1);
                                                            _model.addToAppointments(
                                                                _model
                                                                    .appointment1!);
                                                          } else {
                                                            var appointmentsRecordReference2 =
                                                                AppointmentsRecord
                                                                    .collection
                                                                    .doc();
                                                            await appointmentsRecordReference2
                                                                .set({
                                                              ...createAppointmentsRecordData(
                                                                startDate: functions
                                                                    .combineDateTimeAndTimeString(
                                                                        widget
                                                                            .date!,
                                                                        widget
                                                                            .time!),
                                                                endDate: widget
                                                                    .date,
                                                                price:
                                                                    categoryProductsItem
                                                                        .price,
                                                                duration:
                                                                    categoryProductsItem
                                                                        .duration,
                                                                client: widget
                                                                    .client
                                                                    ?.reference,
                                                                email: widget
                                                                    .client
                                                                    ?.email,
                                                                clientData:
                                                                    createClientDataStruct(
                                                                  name: widget
                                                                      .client
                                                                      ?.name,
                                                                  email: widget
                                                                      .client
                                                                      ?.email,
                                                                  surname: widget
                                                                      .client
                                                                      ?.surname,
                                                                  clearUnsetFields:
                                                                      false,
                                                                  create: true,
                                                                ),
                                                                canceled: false,
                                                                serviceData:
                                                                    updateServiceDataStruct(
                                                                  ServiceDataStruct(
                                                                    name: categoryProductsItem
                                                                        .name,
                                                                    duration:
                                                                        categoryProductsItem
                                                                            .duration,
                                                                    price: categoryProductsItem
                                                                        .price,
                                                                    staffInvolved: widget
                                                                            .isFromSecondAgenda
                                                                        ? 0
                                                                        : categoryProductsItem
                                                                            .staffInvolved,
                                                                    serviceReference:
                                                                        categoryProductsItem
                                                                            .reference,
                                                                  ),
                                                                  clearUnsetFields:
                                                                      false,
                                                                  create: true,
                                                                ),
                                                                accomodation:
                                                                    FFAppState()
                                                                        .selectedAccomodation
                                                                        .accomodation,
                                                                isSecondAgenda:
                                                                    false,
                                                              ),
                                                              ...mapToFirestore(
                                                                {
                                                                  'workers': [
                                                                    widget
                                                                        .operator
                                                                        ?.reference
                                                                  ],
                                                                  'workersData':
                                                                      [
                                                                    getWorkerDataFirestoreData(
                                                                      createWorkerDataStruct(
                                                                        displayName: widget
                                                                            .operator
                                                                            ?.name,
                                                                        clearUnsetFields:
                                                                            false,
                                                                        create:
                                                                            true,
                                                                      ),
                                                                      true,
                                                                    )
                                                                  ],
                                                                },
                                                              ),
                                                            });
                                                            _model.appointment =
                                                                AppointmentsRecord
                                                                    .getDocumentFromData({
                                                              ...createAppointmentsRecordData(
                                                                startDate: functions
                                                                    .combineDateTimeAndTimeString(
                                                                        widget
                                                                            .date!,
                                                                        widget
                                                                            .time!),
                                                                endDate: widget
                                                                    .date,
                                                                price:
                                                                    categoryProductsItem
                                                                        .price,
                                                                duration:
                                                                    categoryProductsItem
                                                                        .duration,
                                                                client: widget
                                                                    .client
                                                                    ?.reference,
                                                                email: widget
                                                                    .client
                                                                    ?.email,
                                                                clientData:
                                                                    createClientDataStruct(
                                                                  name: widget
                                                                      .client
                                                                      ?.name,
                                                                  email: widget
                                                                      .client
                                                                      ?.email,
                                                                  surname: widget
                                                                      .client
                                                                      ?.surname,
                                                                  clearUnsetFields:
                                                                      false,
                                                                  create: true,
                                                                ),
                                                                canceled: false,
                                                                serviceData:
                                                                    updateServiceDataStruct(
                                                                  ServiceDataStruct(
                                                                    name: categoryProductsItem
                                                                        .name,
                                                                    duration:
                                                                        categoryProductsItem
                                                                            .duration,
                                                                    price: categoryProductsItem
                                                                        .price,
                                                                    staffInvolved: widget
                                                                            .isFromSecondAgenda
                                                                        ? 0
                                                                        : categoryProductsItem
                                                                            .staffInvolved,
                                                                    serviceReference:
                                                                        categoryProductsItem
                                                                            .reference,
                                                                  ),
                                                                  clearUnsetFields:
                                                                      false,
                                                                  create: true,
                                                                ),
                                                                accomodation:
                                                                    FFAppState()
                                                                        .selectedAccomodation
                                                                        .accomodation,
                                                                isSecondAgenda:
                                                                    false,
                                                              ),
                                                              ...mapToFirestore(
                                                                {
                                                                  'workers': [
                                                                    widget
                                                                        .operator
                                                                        ?.reference
                                                                  ],
                                                                  'workersData':
                                                                      [
                                                                    getWorkerDataFirestoreData(
                                                                      createWorkerDataStruct(
                                                                        displayName: widget
                                                                            .operator
                                                                            ?.name,
                                                                        clearUnsetFields:
                                                                            false,
                                                                        create:
                                                                            true,
                                                                      ),
                                                                      true,
                                                                    )
                                                                  ],
                                                                },
                                                              ),
                                                            }, appointmentsRecordReference2);
                                                            _model.addToAppointments(
                                                                _model
                                                                    .appointment!);
                                                          }

                                                          if (widget
                                                                  .currentReservation ==
                                                              categoryProductsItem
                                                                  .calendarReservations) {
                                                            await widget
                                                                .client!
                                                                .reference
                                                                .update({
                                                              ...mapToFirestore(
                                                                {
                                                                  'toPay': FieldValue
                                                                      .increment(
                                                                          categoryProductsItem
                                                                              .price),
                                                                },
                                                              ),
                                                            });

                                                            var salesRecordReference =
                                                                SalesRecord
                                                                    .collection
                                                                    .doc();
                                                            await salesRecordReference
                                                                .set({
                                                              ...createSalesRecordData(
                                                                amount:
                                                                    categoryProductsItem
                                                                        .price,
                                                                client:
                                                                    createClientDataStruct(
                                                                  name: widget
                                                                      .client
                                                                      ?.name,
                                                                  email: widget
                                                                      .client
                                                                      ?.email,
                                                                  surname: widget
                                                                      .client
                                                                      ?.email,
                                                                  clientRef: widget
                                                                      .client
                                                                      ?.reference,
                                                                  clearUnsetFields:
                                                                      false,
                                                                  create: true,
                                                                ),
                                                                service:
                                                                    createServiceDataStruct(
                                                                  name:
                                                                      categoryProductsItem
                                                                          .name,
                                                                  duration:
                                                                      categoryProductsItem
                                                                          .duration,
                                                                  price:
                                                                      categoryProductsItem
                                                                          .price,
                                                                  staffInvolved:
                                                                      categoryProductsItem
                                                                          .staffInvolved,
                                                                  serviceReference:
                                                                      categoryProductsItem
                                                                          .reference,
                                                                  fieldValues: {
                                                                    'appointmentsData':
                                                                        getAppointmentDataListFirestoreData(
                                                                      functions.createAppointmentsData(_model
                                                                          .appointments
                                                                          .toList()),
                                                                    ),
                                                                  },
                                                                  clearUnsetFields:
                                                                      false,
                                                                  create: true,
                                                                ),
                                                                accomodation:
                                                                    FFAppState()
                                                                        .selectedAccomodation
                                                                        .accomodation,
                                                              ),
                                                              ...mapToFirestore(
                                                                {
                                                                  'create_time':
                                                                      FieldValue
                                                                          .serverTimestamp(),
                                                                },
                                                              ),
                                                            });
                                                            _model.saleDocument =
                                                                SalesRecord
                                                                    .getDocumentFromData({
                                                              ...createSalesRecordData(
                                                                amount:
                                                                    categoryProductsItem
                                                                        .price,
                                                                client:
                                                                    createClientDataStruct(
                                                                  name: widget
                                                                      .client
                                                                      ?.name,
                                                                  email: widget
                                                                      .client
                                                                      ?.email,
                                                                  surname: widget
                                                                      .client
                                                                      ?.email,
                                                                  clientRef: widget
                                                                      .client
                                                                      ?.reference,
                                                                  clearUnsetFields:
                                                                      false,
                                                                  create: true,
                                                                ),
                                                                service:
                                                                    createServiceDataStruct(
                                                                  name:
                                                                      categoryProductsItem
                                                                          .name,
                                                                  duration:
                                                                      categoryProductsItem
                                                                          .duration,
                                                                  price:
                                                                      categoryProductsItem
                                                                          .price,
                                                                  staffInvolved:
                                                                      categoryProductsItem
                                                                          .staffInvolved,
                                                                  serviceReference:
                                                                      categoryProductsItem
                                                                          .reference,
                                                                  fieldValues: {
                                                                    'appointmentsData':
                                                                        getAppointmentDataListFirestoreData(
                                                                      functions.createAppointmentsData(_model
                                                                          .appointments
                                                                          .toList()),
                                                                    ),
                                                                  },
                                                                  clearUnsetFields:
                                                                      false,
                                                                  create: true,
                                                                ),
                                                                accomodation:
                                                                    FFAppState()
                                                                        .selectedAccomodation
                                                                        .accomodation,
                                                              ),
                                                              ...mapToFirestore(
                                                                {
                                                                  'create_time':
                                                                      DateTime
                                                                          .now(),
                                                                },
                                                              ),
                                                            }, salesRecordReference);

                                                            context.pushNamed(
                                                              SaleConfirmWidget
                                                                  .routeName,
                                                              queryParameters: {
                                                                'sale':
                                                                    serializeParam(
                                                                  _model
                                                                      .saleDocument,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                                'client':
                                                                    serializeParam(
                                                                  widget
                                                                      .client,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                              }.withoutNulls,
                                                              extra: <String,
                                                                  dynamic>{
                                                                'sale': _model
                                                                    .saleDocument,
                                                                'client':
                                                                    widget
                                                                        .client,
                                                              },
                                                            );
                                                          } else {
                                                            context.pushNamed(
                                                              BookingOperatorsSelectionWidget
                                                                  .routeName,
                                                              queryParameters: {
                                                                'service':
                                                                    serializeParam(
                                                                  categoryProductsItem,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                                'client':
                                                                    serializeParam(
                                                                  widget
                                                                      .client,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                                'currentReservation':
                                                                    serializeParam(
                                                                  (widget.currentReservation!) +
                                                                      1,
                                                                  ParamType.int,
                                                                ),
                                                                'appointments':
                                                                    serializeParam(
                                                                  _model
                                                                      .appointments,
                                                                  ParamType
                                                                      .Document,
                                                                  isList: true,
                                                                ),
                                                              }.withoutNulls,
                                                              extra: <String,
                                                                  dynamic>{
                                                                'service':
                                                                    categoryProductsItem,
                                                                'client':
                                                                    widget
                                                                        .client,
                                                                'appointments':
                                                                    _model
                                                                        .appointments,
                                                              },
                                                            );
                                                          }
                                                        } else {
                                                          if (widget
                                                              .isFromSecondAgenda) {
                                                            context.pushNamed(
                                                              BookingDateSelectionWidget
                                                                  .routeName,
                                                              queryParameters: {
                                                                'client':
                                                                    serializeParam(
                                                                  widget
                                                                      .client,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                                'service':
                                                                    serializeParam(
                                                                  categoryProductsItem,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                                'currentReservation':
                                                                    serializeParam(
                                                                  widget
                                                                      .currentReservation,
                                                                  ParamType.int,
                                                                ),
                                                                'date':
                                                                    serializeParam(
                                                                  widget.date,
                                                                  ParamType
                                                                      .DateTime,
                                                                ),
                                                                'isFromSecondAgenda':
                                                                    serializeParam(
                                                                  widget
                                                                      .isFromSecondAgenda,
                                                                  ParamType
                                                                      .bool,
                                                                ),
                                                                'serviceName':
                                                                    serializeParam(
                                                                  serviceCategoriesItem
                                                                      .name,
                                                                  ParamType
                                                                      .String,
                                                                ),
                                                              }.withoutNulls,
                                                              extra: <String,
                                                                  dynamic>{
                                                                'client':
                                                                    widget
                                                                        .client,
                                                                'service':
                                                                    categoryProductsItem,
                                                              },
                                                            );
                                                          } else {
                                                            context.pushNamed(
                                                              BookingOperatorsSelectionWidget
                                                                  .routeName,
                                                              queryParameters: {
                                                                'service':
                                                                    serializeParam(
                                                                  categoryProductsItem,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                                'client':
                                                                    serializeParam(
                                                                  widget
                                                                      .client,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                                'currentReservation':
                                                                    serializeParam(
                                                                  widget
                                                                      .currentReservation,
                                                                  ParamType.int,
                                                                ),
                                                                'date':
                                                                    serializeParam(
                                                                  widget.date,
                                                                  ParamType
                                                                      .DateTime,
                                                                ),
                                                                'time':
                                                                    serializeParam(
                                                                  widget.time,
                                                                  ParamType
                                                                      .String,
                                                                ),
                                                                'operator':
                                                                    serializeParam(
                                                                  widget
                                                                      .operator,
                                                                  ParamType
                                                                      .Document,
                                                                ),
                                                              }.withoutNulls,
                                                              extra: <String,
                                                                  dynamic>{
                                                                'service':
                                                                    categoryProductsItem,
                                                                'client':
                                                                    widget
                                                                        .client,
                                                                'operator':
                                                                    widget
                                                                        .operator,
                                                                kTransitionInfoKey:
                                                                    TransitionInfo(
                                                                  hasTransition:
                                                                      true,
                                                                  transitionType:
                                                                      PageTransitionType
                                                                          .bottomToTop,
                                                                ),
                                                              },
                                                            );
                                                          }
                                                        }

                                                        safeSetState(() {});
                                                      },
                                                      child: FaIcon(
                                                        FontAwesomeIcons
                                                            .calendarPlus,
                                                        color:
                                                            FlutterFlowTheme.of(
                                                                    context)
                                                                .accent1,
                                                        size: 24.0,
                                                      ),
                                                    ),
                                                  ],
                                                ),
                                              ],
                                            ),
                                          ),
                                        );
                                      }),
                                    );
                                  },
                                ),
                              ),
                            ),
                            theme: ExpandableThemeData(
                              tapHeaderToExpand: true,
                              tapBodyToExpand: false,
                              tapBodyToCollapse: false,
                              headerAlignment:
                                  ExpandablePanelHeaderAlignment.center,
                              hasIcon: true,
                            ),
                          ),
                        ),
                      );
                    },
                  );
                },
              );
            },
          ),
        );
      },
    );
  }
}
